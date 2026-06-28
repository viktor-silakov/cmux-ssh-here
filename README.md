# cmux-ssh-here

**Share a shell on this machine in one command — no SSH setup, no keys, no passwords.**

[![npm](https://img.shields.io/npm/v/cmux-ssh-here.svg)](https://www.npmjs.com/package/cmux-ssh-here)
[![CI](https://github.com/viktor-silakov/cmux-ssh-here/actions/workflows/ci.yml/badge.svg)](https://github.com/viktor-silakov/cmux-ssh-here/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/cmux-ssh-here.svg)](./LICENSE)

`cmux-ssh-here` spins up a throwaway, token-authenticated SSH server and prints a [cmux](https://cmux.com) deep link. Send the link to any device on your LAN, open it in cmux, and you're instantly in a terminal on this machine. When you're done, hit `Ctrl-C` — the server, token, and host key vanish.

```bash
npx cmux-ssh-here
```

That's it. No `sshd` to configure, no `~/.ssh/authorized_keys` to edit, no firewall dance.

---

The terminal turns into a live dashboard — the link, a countdown bar for its lifetime, and who's connected:

![cmux-ssh-here dashboard](https://raw.githubusercontent.com/viktor-silakov/cmux-ssh-here/main/assets/dashboard.png)

Open the link and cmux connects on its own — one click, straight into the shell:

![Open in cmux](https://raw.githubusercontent.com/viktor-silakov/cmux-ssh-here/main/assets/open-in-cmux.png)

## Why you'll like it

- ⚡ **Zero setup** — one `npx` command, no SSH server administration.
- 🔑 **No credentials to share** — auth is a one-time token baked into the link.
- ⏳ **Self-expiring** — the link rotates every 3 minutes; leaked links go stale on their own. Live sessions stay connected.
- 👀 **Live dashboard** — see the current link, a countdown bar, and every connected client at a glance.
- 🧩 **Real SSH** — full PTY shell, `scp`/`sftp`, and the exec channel cmux needs to bootstrap remote workspaces.
- 🪟 **Persistent sessions** — when `tmux` is present, sessions survive disconnects and are shared across connections.

## Quick start

```bash
# on the machine you want to reach
npx cmux-ssh-here
```

Then open the printed `https://cmux.com/deeplink/ssh?…` link in cmux on any device on the same network.

## How it works

- Its own SSH server (`ssh2`) with an ephemeral host key and token — both live only while the process runs.
- The token rides in the deep link's `user=`; the server accepts only that token, and rotates it every 3 minutes.
- cmux deep links deliberately carry no passwords or keys, so the secret is the token itself.
- Full PTY shell via `node-pty`, a raw-pipe exec channel, and a filesystem-backed SFTP server — together they let `cmux ssh` upload and run its remote helper (a shell-only server isn't enough).
- With `tmux` available, the interactive shell runs inside it: sessions persist, are shared across connections, and the session list (`choose-tree`) is shown on connect.

## Compatibility

| Host running `npx cmux-ssh-here` | Supported |
| --- | --- |
| macOS | ✅ |
| Linux | ✅ |
| Windows | ❌ — needs a POSIX shell, and cmux's remote daemon has no Windows build |

The device you open the link from just needs [cmux](https://cmux.com) installed. Node 18+ is required on the host. `tmux` is optional (for persistent, shared sessions).

## Security

⚠️ **The token in the link is a bearer secret that grants a shell as your user.** Use it on a trusted local network only. Don't publish the link or send it over untrusted channels. Close the terminal and the token and host key are gone.

## Options

- `PORT=2222 npx cmux-ssh-here` — fixed port (random free port by default).
- `CMUX_SSH_TTL=600 npx cmux-ssh-here` — link/token lifetime in seconds before regeneration (default 180).
- `CMUX_SSH_DEBUG=1 npx cmux-ssh-here` — log incoming auth/env/exec/shell requests to stderr (disables the live dashboard).

## License

MIT
