#!/usr/bin/env node
// npx cmux-ssh-here
// Spins up an ephemeral token-auth SSH server and prints a cmux deep link.
// Anyone on the LAN who opens the link lands in a shell as the current user.
// ponytail: the token is a bearer secret. Trusted LAN only, not the internet.
//
// This is a near-full SSH server (auth + pty/shell + exec + SFTP) on purpose:
// cmux's `cmux ssh` flow scp-uploads a helper daemon (cmuxd-remote) and then
// talks a binary protocol to it over an exec channel. A shell-only server is
// not enough; SFTP (for scp) and raw-pipe exec (binary-clean) are required.
import ssh2 from "ssh2"; // ponytail: ssh2 is CJS, no named exports
const { Server } = ssh2;
const { OPEN_MODE, STATUS_CODE } = ssh2.utils.sftp;
import { generateKeyPairSync, randomBytes } from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import qrcodeTerminal from "qrcode-terminal";

// ponytail: the host side needs a POSIX shell + scp/exec semantics, and cmux's
// own remote daemon only ships linux/darwin/freebsd builds — so a Windows host
// can't serve `cmux ssh`. Fail fast with a clear message instead of crashing later.
if (process.platform === "win32") {
  console.error("cmux-ssh-here must run on a macOS or Linux host (POSIX shell required). Windows is not supported.");
  process.exit(1);
}

// ponytail: node-pty's prebuilt spawn-helper sometimes unpacks without +x
// (packaging bug) -> "posix_spawnp failed". Fix it before importing.
if (process.platform !== "win32") {
  try {
    const root = dirname(dirname(createRequire(import.meta.url).resolve("node-pty")));
    chmodSync(join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"), 0o755);
  } catch {}
}
const { default: pty } = await import("node-pty");

// ponytail: hex (not base64url) — cmux rejects a user that starts with "-",
// and an ssh client treats a leading-dash username as a flag. Hex is URL/ssh-safe.
const TTL_SECONDS = Number(process.env.CMUX_SSH_TTL) || 180; // link/token lifetime before regeneration
let token; // secret carried in user=<token>; rotated every TTL_SECONDS
let expiry; // epoch ms when the current token expires
const regenerateToken = () => {
  token = randomBytes(12).toString("hex");
  expiry = Date.now() + TTL_SECONDS * 1000;
};
regenerateToken();

// --once: single-use link. After the first client connects, lock to its IP and
// stop rotating — new machines are rejected, but that client's several
// connections (cmux opens ControlMaster + daemon + probes) keep working.
const ONCE = process.argv.includes("--once");
let consumed = false;
let lockedIp = null;

// Active authenticated connections, shown live in the server terminal.
const sessions = new Map();
let nextSid = 0;
const { privateKey } = generateKeyPairSync("rsa", {
  // ponytail: rsa PEM parses cleanly in ssh2 (ed25519 PKCS8 is hit-or-miss)
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

// ponytail: $SHELL is set on real logins; the fallback only matters in bare
// envs — bash on Linux, zsh on macOS.
const shellPath = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
const debug = process.env.CMUX_SSH_DEBUG ? (...a) => console.error("[debug]", ...a) : () => {};

const lanIP = () =>
  Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i?.family === "IPv4" && !i.internal && !i.address.startsWith("169.254"))?.address;

// Interactive shell over a PTY (plain `ssh user@host` with no remote command).
function startShell(stream, term) {
  // ponytail: route the interactive shell through tmux so sessions persist and
  // are shared across LAN connections; show the session list on connect.
  // Falls back to a plain login shell when tmux is absent.
  const start =
    'if command -v tmux >/dev/null 2>&1; then ' +
    'exec tmux new-session -A -s main \\; choose-tree -Zs; ' +
    'else printf "[cmux-ssh-here] tmux not found; opening a plain shell\\n"; ' +
    'exec "$SHELL" -l; fi';
  const child = pty.spawn(shellPath, ["-lc", start], {
    name: term.term,
    cols: term.cols,
    rows: term.rows,
    cwd: os.homedir(),
    env: { ...process.env, ...term.env },
  });
  child.onData((d) => stream.write(d));
  stream.on("data", (d) => child.write(d.toString()));
  child.onExit(({ exitCode }) => {
    try { stream.exit(exitCode ?? 0); } catch {}
    stream.end();
  });
  return child;
}

// exec channel: run a command with RAW pipes (no PTY) so binary protocols
// (cmux's daemon stdio) stay byte-exact. Faithful to how sshd runs exec.
function startExec(stream, command, env) {
  const child = spawn(shellPath, ["-c", command], { cwd: os.homedir(), env: { ...process.env, ...env } });
  child.stdout.on("data", (d) => stream.write(d));
  child.stderr.on("data", (d) => stream.stderr.write(d));
  stream.on("data", (d) => child.stdin.write(d));
  stream.on("end", () => child.stdin.end());
  child.on("close", (code) => {
    try { stream.exit(code ?? 0); } catch {}
    stream.end();
  });
  child.on("error", () => {
    try { stream.exit(127); } catch {}
    stream.end();
  });
  return child;
}

// Minimal real-filesystem SFTP server so `scp`/`sftp` work (cmux uploads its
// daemon via scp, which uses the SFTP subsystem on modern OpenSSH).
function attachSFTP(accept) {
  const sftp = accept();
  // ponytail: client half-closes (EOF) after its last request. A real sshd sends
  // exit-status 0 then EOF/close for the sftp subsystem; without it scp/sftp
  // report failure ("Exit status -1") even though the transfer succeeded.
  // These are ssh2 internals (no public exit() on the SFTP wrapper), but stable.
  sftp.on("end", () => {
    try {
      sftp._protocol.exitStatus(sftp.outgoing.id, 0);
      sftp._protocol.channelEOF(sftp.outgoing.id);
    } catch {}
    sftp.end();
  });
  const handles = new Map();
  let next = 0;
  const open = (obj) => {
    const id = next++;
    handles.set(id, obj);
    const b = Buffer.alloc(4);
    b.writeUInt32BE(id, 0);
    return b;
  };
  const get = (h) => (h.length === 4 ? handles.get(h.readUInt32BE(0)) : undefined);
  const fail = (reqid, err) =>
    sftp.status(
      reqid,
      err?.code === "ENOENT"
        ? STATUS_CODE.NO_SUCH_FILE
        : err?.code === "EACCES" || err?.code === "EPERM"
          ? STATUS_CODE.PERMISSION_DENIED
          : STATUS_CODE.FAILURE
    );
  const toAttrs = (st) => ({
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  });
  const fsFlags = (flags) => {
    const C = fs.constants;
    let f = flags & OPEN_MODE.READ && flags & OPEN_MODE.WRITE ? C.O_RDWR : flags & OPEN_MODE.WRITE ? C.O_WRONLY : C.O_RDONLY;
    if (flags & OPEN_MODE.APPEND) f |= C.O_APPEND;
    if (flags & OPEN_MODE.CREAT) f |= C.O_CREAT;
    if (flags & OPEN_MODE.TRUNC) f |= C.O_TRUNC;
    if (flags & OPEN_MODE.EXCL) f |= C.O_EXCL;
    return f;
  };

  sftp.on("REALPATH", (reqid, p) => {
    let r;
    try {
      r = fs.realpathSync(p === "" ? "." : p);
    } catch {
      r = p.startsWith("/") ? resolve(p) : join(os.homedir(), p === "." ? "" : p);
    }
    sftp.name(reqid, [{ filename: r, longname: r, attrs: {} }]);
  });
  sftp.on("OPEN", (reqid, filename, flags, attrs) => {
    fs.open(filename, fsFlags(flags), attrs?.mode ?? 0o644, (err, fd) => {
      if (err) return fail(reqid, err);
      sftp.handle(reqid, open({ fd, path: filename }));
    });
  });
  sftp.on("WRITE", (reqid, handle, offset, data) => {
    const h = get(handle);
    if (!h || h.fd == null) return sftp.status(reqid, STATUS_CODE.FAILURE);
    fs.write(h.fd, data, 0, data.length, offset, (err) => (err ? fail(reqid, err) : sftp.status(reqid, STATUS_CODE.OK)));
  });
  sftp.on("READ", (reqid, handle, offset, length) => {
    const h = get(handle);
    if (!h || h.fd == null) return sftp.status(reqid, STATUS_CODE.FAILURE);
    const buf = Buffer.alloc(length);
    fs.read(h.fd, buf, 0, length, offset, (err, bytes) => {
      if (err) return fail(reqid, err);
      if (!bytes) return sftp.status(reqid, STATUS_CODE.EOF);
      sftp.data(reqid, buf.subarray(0, bytes));
    });
  });
  sftp.on("FSTAT", (reqid, handle) => {
    const h = get(handle);
    if (!h || h.fd == null) return sftp.status(reqid, STATUS_CODE.FAILURE);
    fs.fstat(h.fd, (err, st) => (err ? fail(reqid, err) : sftp.attrs(reqid, toAttrs(st))));
  });
  sftp.on("FSETSTAT", (reqid, handle, attrs) => {
    const h = get(handle);
    if (!h || h.fd == null) return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (attrs?.mode != null) {
      try { fs.fchmodSync(h.fd, attrs.mode); } catch (e) { return fail(reqid, e); }
    }
    sftp.status(reqid, STATUS_CODE.OK);
  });
  sftp.on("CLOSE", (reqid, handle) => {
    const h = get(handle);
    if (h?.fd != null) try { fs.closeSync(h.fd); } catch {}
    if (h) handles.delete(handle.readUInt32BE(0));
    sftp.status(reqid, STATUS_CODE.OK);
  });
  const onStat = (reqid, p) => fs.stat(p, (err, st) => (err ? fail(reqid, err) : sftp.attrs(reqid, toAttrs(st))));
  sftp.on("STAT", onStat);
  sftp.on("LSTAT", (reqid, p) => fs.lstat(p, (err, st) => (err ? fail(reqid, err) : sftp.attrs(reqid, toAttrs(st)))));
  sftp.on("SETSTAT", (reqid, p, attrs) => {
    if (attrs?.mode != null) {
      try { fs.chmodSync(p, attrs.mode); } catch (e) { return fail(reqid, e); }
    }
    sftp.status(reqid, STATUS_CODE.OK);
  });
  sftp.on("MKDIR", (reqid, p, attrs) =>
    fs.mkdir(p, { mode: attrs?.mode ?? 0o755 }, (err) => (err ? fail(reqid, err) : sftp.status(reqid, STATUS_CODE.OK)))
  );
  sftp.on("RMDIR", (reqid, p) => fs.rmdir(p, (err) => (err ? fail(reqid, err) : sftp.status(reqid, STATUS_CODE.OK))));
  sftp.on("REMOVE", (reqid, p) => fs.unlink(p, (err) => (err ? fail(reqid, err) : sftp.status(reqid, STATUS_CODE.OK))));
  sftp.on("RENAME", (reqid, from, to) =>
    fs.rename(from, to, (err) => (err ? fail(reqid, err) : sftp.status(reqid, STATUS_CODE.OK)))
  );
  sftp.on("OPENDIR", (reqid, p) => {
    try {
      sftp.handle(reqid, open({ dir: p, entries: fs.readdirSync(p), idx: 0 }));
    } catch (e) {
      fail(reqid, e);
    }
  });
  sftp.on("READDIR", (reqid, handle) => {
    const h = get(handle);
    if (!h || !h.entries) return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (h.idx >= h.entries.length) return sftp.status(reqid, STATUS_CODE.EOF);
    const names = h.entries.slice(h.idx).map((name) => {
      let st;
      try { st = fs.lstatSync(join(h.dir, name)); } catch {}
      return { filename: name, longname: name, attrs: st ? toAttrs(st) : {} };
    });
    h.idx = h.entries.length;
    sftp.name(reqid, names);
  });
}

const serverCfg = { hostKeys: [privateKey] };
if (process.env.CMUX_SSH2_DEBUG) serverCfg.debug = (m) => { if (/SFTP|CHANNEL|EOF|CLOSE/.test(m)) console.error("[ssh2]", m); };
let render = () => {}; // assigned once the server is listening (knows ip/port)
const server = new Server(serverCfg, (client, info) => {
  client.on("authentication", (ctx) => {
    debug("auth", ctx.method, ctx.username);
    // Correct token, plus (in --once after consumption) only the locked-in IP.
    const ok = ctx.username === token && (!consumed || info?.ip === lockedIp);
    return ok ? ctx.accept() : ctx.reject();
  });
  client.on("ready", () => {
    // ponytail: just track the connection; the 5s timer redraws — no per-event
    // repaint (that was the screen-churn that broke copying).
    const id = nextSid++;
    sessions.set(id, { ip: info?.ip || "?", since: Date.now() });
    if (ONCE && !consumed) {
      consumed = true;
      lockedIp = info?.ip || "?";
    }
    client.on("close", () => sessions.delete(id));
  });
  client.on("session", (accept) => {
    const session = accept();
    const term = { term: "xterm-256color", cols: 80, rows: 24, env: {} };
    let child;

    session.on("pty", (a, _r, info) => {
      debug("pty", info.term, info.cols, info.rows);
      term.term = info.term || term.term;
      term.cols = info.cols || term.cols;
      term.rows = info.rows || term.rows;
      a?.();
    });
    session.on("env", (a, _r, info) => {
      debug("env", info.key, "=", info.val);
      term.env[info.key] = info.val;
      a?.();
    });
    session.on("window-change", (a, _r, info) => {
      child?.resize?.(info.cols, info.rows);
      a?.();
    });
    session.on("shell", (acc) => {
      debug("shell");
      child = startShell(acc(), term);
    });
    session.on("exec", (acc, _r, info) => {
      debug("exec", info.command);
      child = startExec(acc(), info.command, term.env);
    });
    session.on("sftp", (acc) => {
      debug("sftp");
      attachSFTP(acc);
    });
    // ponytail: no 'subsystem' handler — ssh2 auto-rejects non-sftp subsystems,
    // and a handler here also intercepts the sftp request and kills the channel.
  });
});

server.on("error", (e) => {
  console.error(`Server error: ${e.message}`);
  process.exit(1);
});

const PORT = Number(process.env.PORT) || 0; // 0 = random free port
server.listen(PORT, "0.0.0.0", function () {
  const ip = lanIP();
  if (!ip) {
    console.error("No LAN IPv4 address found");
    process.exit(1);
  }
  const port = this.address().port;
  const user = os.userInfo().username;
  const buildLink = () => {
    const params = new URLSearchParams({
      host: ip,
      port: String(port),
      user: token,
      "host-key-policy": "accept-new",
      title: os.hostname(),
    });
    return `https://cmux.com/deeplink/ssh?${params}`;
  };
  // Plain SSH command for any client (phone via Termius/Blink, Linux, Windows).
  // Token is the username; rebuilt each render so it tracks rotation.
  const buildSsh = () => `ssh ${token}@${ip} -p ${port}`;
  // ssh:// deep link — tap to open directly in clients that register the scheme
  // (WebSSH, Termius, Blink, Prompt, …). https://webssh.net/documentation/help/howtos/use-deep-linking/
  const buildSshUrl = () => `ssh://${token}@${ip}:${port}`;

  // ponytail: in debug mode skip the dashboard so logs stay readable.
  const liveUI = !process.env.CMUX_SSH_DEBUG;
  const REFRESH_MS = 5000; // ponytail: 5s cadence — long enough to select & copy the link
  const ago = (since) => `${Math.floor((Date.now() - since) / 1000)}s`;
  const remainingSec = () => Math.max(0, Math.ceil((expiry - Date.now()) / 1000));

  // Decreasing progress bar for the link's remaining lifetime.
  const bar = (rem) => {
    const W = 28;
    const filled = Math.round((rem / TTL_SECONDS) * W);
    return `[${"█".repeat(filled)}${"░".repeat(W - filled)}]`;
  };

  // ASCII QR of the current cmux deep link.
  const qrFor = (text) => {
    let out = "";
    qrcodeTerminal.generate(text, { small: true }, (q) => (out = q));
    return out
      .split("\n")
      .map((l) => "  " + l)
      .join("\n");
  };

  // Collapse cmux's several SSH connections from one machine into one row per IP.
  const sessionRows = () => {
    const byIp = new Map();
    for (const s of sessions.values()) {
      const e = byIp.get(s.ip);
      if (e) { e.count++; e.since = Math.min(e.since, s.since); }
      else byIp.set(s.ip, { count: 1, since: s.since });
    }
    return [...byIp.entries()].map(
      ([ipAddr, e]) => `    • ${ipAddr}  connected ${ago(e.since)} ago${e.count > 1 ? `  (${e.count} connections)` : ""}`
    );
  };

  const mode = ONCE ? " (one-time link)" : "";

  render = () => {
    if (!liveUI) return;
    const rem = remainingSec();
    const link = buildLink();
    const lines = [
      "",
      `  cmux-ssh-here — shell as ${user} over the LAN${mode}`,
      "",
      "  Open in cmux:",
      `  ${link}`,
      "",
      qrFor(link),
      "",
      "  Or with any SSH client (copy the command, or tap the link):",
      `  ${buildSsh()}`,
      `  ${buildSshUrl()}`,
      "",
    ];
    if (consumed) lines.push(`  🔒 One-time link used — locked to ${lockedIp}.`);
    else lines.push(`  Link valid  ${bar(rem)} ${rem}s`);
    lines.push("");
    const rows = sessionRows();
    if (rows.length) lines.push(`  Connected (${rows.length}):`, ...rows);
    else lines.push("  No active sessions yet.");
    lines.push("", "  Updates every 5s · Ctrl-C to stop.", "");
    // Home + clear-to-end (not full \x1b[2J): redraw in the same spot every 5s.
    process.stdout.write(`\x1b[H\x1b[J${lines.join("\n")}\n`);
  };

  if (liveUI) render();
  else console.log(`\n  Open in cmux (regenerates in ${remainingSec()}s):\n  ${buildLink()}\n  Or any SSH client:\n  ${buildSsh()}\n  ${buildSshUrl()}\n`);

  // Refresh every 5s: regenerate the link when it expires (unless a one-time
  // link has already been consumed — then it's frozen), then redraw.
  setInterval(() => {
    if (!consumed && remainingSec() <= 0) {
      regenerateToken();
      if (!liveUI) console.log(`\n  [link regenerated]\n  ${buildLink()}\n`);
    }
    render();
  }, REFRESH_MS);
});
