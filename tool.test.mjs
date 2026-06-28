// End-to-end tests: start the real server, then drive it with the system
// ssh/scp clients — the same channels cmux uses (auth, exec, SFTP).
// No test framework: built-in node:test + node:assert only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const SSH_OPTS = ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR"];

let server, port, token;

before(async () => {
  server = spawn("node", [join(here, "bin.js")], {
    cwd: here,
    env: { ...process.env, CMUX_SSH_TTL: "3600" }, // no rotation mid-test
  });
  const link = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("server never printed a link:\n" + buf)), 20000);
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/https:\/\/cmux\.com\/deeplink\/ssh\?\S+/);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    };
    server.stdout.on("data", onData);
    server.stderr.on("data", (d) => (buf += d.toString()));
    server.on("exit", (code) => reject(new Error(`server exited early (${code}):\n` + buf)));
  });
  port = link.match(/port=(\d+)/)[1];
  token = link.match(/user=([a-f0-9]+)/)[1];
});

after(() => server?.kill("SIGKILL"));

const ssh = (user, cmd) =>
  spawnSync("ssh", ["-p", port, ...SSH_OPTS, `${user}@127.0.0.1`, cmd], { encoding: "utf8", timeout: 20000 });

test("exec returns output and propagates exit code", () => {
  const r = ssh(token, "echo cmux_ok_$((6*7)); exit 7");
  assert.equal(r.status, 7);
  assert.match(r.stdout, /cmux_ok_42/);
});

test("exec is binary-clean over raw pipes", () => {
  const r = ssh(token, "head -c 65536 /dev/urandom | wc -c");
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "65536");
});

test("wrong token is rejected", () => {
  const r = ssh("deadbeefdeadbeefdeadbeef", "echo should-not-run");
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout || "", /should-not-run/);
});

test("scp upload over SFTP is byte-identical", () => {
  const dir = mkdtempSync(join(tmpdir(), "cmux-ssh-test-"));
  try {
    const src = join(dir, "src.bin");
    const dst = join(dir, "dst.bin");
    const data = randomBytes(300_000);
    writeFileSync(src, data);
    const up = spawnSync("scp", ["-P", port, ...SSH_OPTS, src, `${token}@127.0.0.1:${dst}`], {
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(up.status, 0, up.stderr);
    assert.deepEqual(readFileSync(dst), data);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scp download over SFTP is byte-identical", () => {
  const dir = mkdtempSync(join(tmpdir(), "cmux-ssh-test-"));
  try {
    const src = join(dir, "remote.bin");
    const out = join(dir, "back.bin");
    const data = randomBytes(150_000);
    writeFileSync(src, data);
    const down = spawnSync("scp", ["-P", port, ...SSH_OPTS, `${token}@127.0.0.1:${src}`, out], {
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(down.status, 0, down.stderr);
    assert.deepEqual(readFileSync(out), data);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
