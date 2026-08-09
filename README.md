<div align="center">

# Vibe

**English** · [简体中文](README.zh-CN.md)

**An elegant, low‑latency web UI for driving Claude Code, Codex, Cursor, Kimi, and Kiro agents on any machine.**

Run it on the machine where your code lives, open the printed link from any browser
(laptop, phone, tablet), and vibe‑code remotely with smooth streaming and a clean interface.

<br/>

<img src="docs/screenshots/hero-dark.png" alt="Vibe — chat interface with streaming, thinking, and tool cards" width="900" />

<table>
<tr>
<td width="33%" align="center"><img src="docs/screenshots/light.png" alt="Light and dark themes" /><br/><sub><b>Dark &amp; light themes</b></sub></td>
<td width="33%" align="center"><img src="docs/screenshots/new-session.png" alt="New session dialog" /><br/><sub><b>Start on any machine</b></sub></td>
<td width="33%" align="center"><img src="docs/screenshots/terminal.png" alt="Built-in terminal" /><br/><sub><b>Built‑in terminal</b></sub></td>
</tr>
</table>

<br/>

<table>
<tr>
<td align="center" width="50%"><img src="docs/screenshots/mobile-chat.png" alt="Vibe on mobile — streaming chat" height="460" /></td>
<td align="center" width="50%"><img src="docs/screenshots/mobile-sessions.png" alt="Vibe on mobile — session drawer" height="460" /></td>
</tr>
<tr>
<td align="center"><sub><b>Streaming chat on mobile</b></sub></td>
<td align="center"><sub><b>Sessions &amp; navigation</b></sub></td>
</tr>
</table>

</div>

---

## Why Vibe

Vibe runs a small server on your machine that talks to Claude Code, Codex, Cursor,
Kimi Code, or Kiro, normalizes each agent's stream into the same structured conversation
model, and sends it to a React web client over a single WebSocket. Claude sessions
use the official [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk);
Codex runs through its long-lived App Server, while Cursor, Kimi, and Kiro use
their structured CLI/ACP transports.

It was built to fix two things that make other remote coding-agent UIs feel clunky:

- **Communication that never stalls.** Every state change carries a monotonic `seq`.
  Reconnects replay only what you missed instead of refetching the whole transcript,
  streaming text is coalesced per animation frame, and a backpressure‑aware sender drops
  only best‑effort delta frames (never structural ones) when a client falls behind.
- **An interface that feels good.** A calm dark or light theme, real‑time
  token/thinking/tool streaming, thoughts that expand while the agent thinks and collapse when
  done, tool cards with live status, inline permission prompts, a context‑usage meter, and
  an integrated terminal.

## Features

- 💬 **Structured chat loop** — streaming assistant text, thinking, tool calls, and results
- 🧰 **Tool visibility** — Bash/Read/Edit/Grep/… rendered as compact cards with status + output
- ⏳ **Background task control** — Claude tasks, Kimi background tools, and Codex background
  terminals share one live task pane with expandable metadata, command/instructions, captured
  output, and per-task stop where the engine exposes it; task completion automatically wakes
  the agent for a follow-up reply, while the composer remains available between foreground turns;
  stopping the current reply leaves background tasks and their completion notifications running
- 🤖 **Multiple agents** — choose Claude, Codex, Cursor, Kimi, or Kiro per session, with agent-specific
  model, reasoning, and permission controls
- 🔐 **Permission controls** — Claude supports inline Allow / Always allow / Deny prompts;
  Codex and Cursor use coarse modes; Kimi discovers Default / Plan / Auto / YOLO from its
  installed CLI and drives approvals over ACP
- 🗂 **Sessions** — create in any directory, resume, rename, delete; history loaded from
  agent transcript stores and Vibe-managed transcripts where available
- 🖥️ **Picks up your CLI sessions** — conversations you started in the terminal with
  `claude`, `codex`, `cursor-agent`, `kimi`, or `kiro-cli` appear automatically when their local history is readable;
  open them to read the full history and keep chatting
- 🌐 **Remote hosts over SSH** — add machines you reach via SSH and run the selected agent
  on that machine; sessions you started on that host's own CLIs (Claude, Codex, Cursor, Kimi,
  Kiro) are discovered automatically, and Vibe-created remote sessions can use any of them
  when the CLI is installed on the host
- 💻 **Integrated terminal** — one click opens a real interactive shell on the session's host
  (a local login shell, or `ssh` into the remote), in the session's directory, in a resizable
  side panel
- 🎛 **Per‑session controls** — choose the agent when creating a session, then switch
  model, reasoning effort, and permission mode from the header
- 📎 **File attachments** — attach, drag‑drop, or paste images into the composer; files
  are uploaded to the session's host (locally or over SSH) and the agent reads them with
  its own file tools, so it works for every engine
- 🔌 **MCP servers** — define Model Context Protocol servers (stdio / sse / http) once,
  then enable them per host; OAuth ("sign in") servers are connected and token‑refreshed
  for you
- 🔖 **Session presets** — save an agent + model + permission + effort bundle and apply
  it in one click from the New session dialog
- 🔔 **Notifications** — a configurable completion cue plays when a turn ends (on the open
  session *or* any background one), and sessions with a finished‑but‑unseen reply get an
  unread marker in the sidebar; turns you abort yourself stay silent
- 🌗 **Dark & light themes** with a one‑click toggle (remembers your choice)
- 📈 **Context meter** and per‑turn cost/duration
- 🔁 **Robust reconnection** with seq‑based replay (no lost or duplicated messages)
- 📱 **Responsive** — works on desktop and mobile browsers
- 🤖 **Telegram bot** — create/switch sessions, stream chat, and answer permissions from Telegram

## Requirements

- **Node.js 20+**
- **At least one supported agent CLI** installed and authenticated on the machine running Vibe:
  - Claude Code (`claude`)
  - Codex CLI (`codex`)
  - Cursor CLI / agent (`cursor-agent`)
  - [Kimi Code CLI](https://moonshotai.github.io/kimi-code/) (`kimi`)
  - [Kiro CLI](https://kiro.dev/cli/) (`kiro-cli`)

Vibe auto-detects these binaries on `PATH` and common install locations. It uses each
CLI's existing authentication and config; for Claude that includes MCP servers,
`CLAUDE.md`, custom `ANTHROPIC_BASE_URL`/model mappings, and permission settings.

## Quick start

```bash
npm install
npm run serve        # builds the web client and starts the server
```

The server prints ready‑to‑open links with an access token:

```
  http://localhost:8787/?token=XXXXXXXX
  http://192.168.1.20:8787/?token=XXXXXXXX   # open this from your phone on the same network
```

Open one of them and start a session.

### Development

```bash
npm run dev          # Vite dev server (5173) + auto-reloading API server (8787)
```

Open `http://localhost:5173/?token=...` (the token is printed by the server process).

## Accessing from another network

Vibe uses a **direct connection** model — the browser connects straight to the server.
On the same LAN, just use the machine's IP. To reach it from anywhere, put it behind a
tunnel such as [Tailscale](https://tailscale.com), [cloudflared](https://github.com/cloudflare/cloudflared),
or `ssh -L`. (No data passes through any third‑party relay.)

## Configuration

All optional, via environment variables:

| Variable | Default | Description |
|---|---|---|
| `VIBE_PORT` | `8787` | Port to listen on |
| `VIBE_HOST` | `0.0.0.0` | Bind address |
| `VIBE_TOKEN` | auto‑generated | Access token (persisted at `~/.vibe/token` if not set) |
| `VIBE_HOME` | `~/.vibe` | Where Vibe stores its token + session index |
| `VIBE_DEFAULT_MODEL` | `opus` | Default Claude model for new sessions |
| `VIBE_DEFAULT_EFFORT` | `max` | Default reasoning effort for Claude/Codex (`low`/`medium`/`high`/`xhigh`/`max`/`ultra`) |
| `VIBE_DEFAULT_CURSOR_MODEL` | `auto` | Default Cursor model for new sessions |
| `VIBE_DEFAULT_CODEX_MODEL` | `auto` | Default Codex model for new sessions |
| `VIBE_DEFAULT_KIMI_MODEL` | `auto` | Default Kimi model alias; `auto` preserves Kimi's own config |
| `VIBE_DEFAULT_KIRO_MODEL` | `auto` | Default Kiro model; `auto` lets Kiro pick |
| `VIBE_DEFAULT_AGENT` | `claude` | Default agent (`claude`/`cursor`/`codex`/`kimi`/`kiro`) |
| `CLAUDE_CLI_PATH` | auto‑detected | Explicit path to the `claude` binary |
| `CURSOR_CLI_PATH` | auto‑detected | Explicit path to the `cursor-agent` binary |
| `CODEX_CLI_PATH` | auto‑detected | Explicit path to the `codex` binary |
| `KIMI_CLI_PATH` | auto‑detected | Explicit path to the `kimi` binary (native installs under `~/.kimi-code/bin/kimi` are detected) |
| `KIRO_CLI_PATH` | auto‑detected | Explicit path to the `kiro-cli` binary (installs under `~/.local/bin/kiro-cli` are detected) |
| `VIBE_LOCAL_NAME` | machine hostname | Label shown for this (local) machine |
| `VIBE_SSH_HOSTS` | – | Seed remote hosts, e.g. `prod=user@1.2.3.4,gpu=mygpu-alias` |
| `VIBE_SSH` | `ssh` | SSH command to use (override for custom options) |
| `VIBE_TELEGRAM_BOT_TOKEN` | – | Telegram bot token from [@BotFather](https://t.me/BotFather). When set, Vibe starts a bot alongside the web UI. If unset, falls back to `~/.vibe/telegram-bot-token` |
| `VIBE_TELEGRAM_ALLOWLIST` | – | Comma-separated Telegram user ids allowed to use the bot. Empty = anyone who can message the bot |

## Telegram bot

Drive the same sessions from Telegram — create/switch sessions, stream replies, and
answer permission prompts with inline buttons.

1. Talk to [@BotFather](https://t.me/BotFather), create a bot, copy the token.
2. Save it locally (recommended) or pass via env:

```bash
# Persist under ~/.vibe (mode 0600) — survives restarts without exporting env
printf '%s\n' '123456:ABC…' > ~/.vibe/telegram-bot-token
chmod 600 ~/.vibe/telegram-bot-token

# Optional: only allow your Telegram user id (printed by /start)
export VIBE_TELEGRAM_ALLOWLIST=7654321

npm run serve
```

Or with env only: `export VIBE_TELEGRAM_BOT_TOKEN=123456:ABC…`

3. Open a private chat with the bot and send `/start`.

| Command | What it does |
|---|---|
| `/sessions` | List sessions (tap a button to switch) |
| `/use <n\|id>` | Switch active session |
| `/new [cwd]` | Create a session (wizard if no path) |
| `/status` | Show the active session |
| `/abort` | Stop the current turn |
| `/model` `/effort` `/mode` | Change session settings |
| *(plain text)* | Chat in the active session — streams live |

Permission prompts arrive as messages with **Allow / Always / Deny** buttons.
Active session per chat is remembered in `~/.vibe/telegram.json`.

## Remote hosts (SSH)

Open **Hosts** in the sidebar to add a machine by an `~/.ssh/config` alias or `user@host`.
Vibe can run Claude, Codex, Cursor, Kimi, or Kiro turns on that machine over SSH. Sessions that
already exist on the host's own CLIs are discovered in the sidebar (tagged with the host name and
the owning agent), and Vibe-created remote sessions continue with whichever agent you selected
for that session.

Remote discovery reads each agent's native store over SSH: `~/.claude/projects` (Claude),
`~/.codex/sessions` (Codex), `$KIMI_CODE_HOME`'s session index (Kimi), `~/.kiro/sessions/cli`
(Kiro) and `~/.cursor/chats` (Cursor). Two caveats mirror the local behavior: a Cursor chat is
only recoverable when Vibe can name its working directory (Cursor records only a hash of it), and
rendering a remote Cursor chat's own history needs `sqlite3` on that host.

Requirements:

- **Key-based auth / ssh-agent** — Vibe connects non-interactively (`BatchMode`), so the host
  must authenticate without a password prompt.
- The selected agent CLI installed and authenticated on the remote (`claude`, `codex`,
  `cursor-agent`, `kimi`, or `kiro-cli`). The Hosts dialog probes each agent’s install + version and can update them.
- Remote turns honor the session's supported **permission mode**. Interactive per-tool
  Claude approval prompts are a local-only feature; Codex, Cursor, Kimi, and Kiro use headless/ACP modes.

## Terminal

The **Terminal** button (top‑right of a session) opens a resizable side panel with a real
interactive shell **on that session's host**, in the session's working directory:

- a local login shell for local sessions, or `ssh -tt` into the host for remote ones;
- the host's full environment is loaded (so version managers like nvm, your aliases, etc. work);
- drag the panel's left edge to resize (the width is remembered).

## MCP servers, presets & notifications

Open **Settings** (the gear in the sidebar) to manage shared engine configuration:

- **MCP servers** — register a Model Context Protocol server once (a stdio command, or an
  `sse`/`http` endpoint), then toggle it on per host: "Enabled on this machine" here, and per
  remote host in the Hosts dialog. For remote hosts the stdio command runs on that machine, so
  reference executables that exist there. `http`/`sse` servers can use static headers or
  **MCP‑OAuth**: click *Connect* to sign in through your browser — Vibe runs the RFC 9728 → 8414
  → 7591 + PKCE flow, stores and refreshes the access token (mode 0600), and injects it every
  turn. Editing the registry applies to the next turn.
- **Session presets** — save a named bundle of agent + model + permission mode + reasoning
  effort, then pick it from the New session dialog to apply all four at once. Presets are
  host‑agnostic; anything invalid for the chosen machine (e.g. a model not installed there) is
  reconciled when applied.
- **Completion sound** — pick a turn‑finished cue (Chime / Ping / Bell / Pop / Success, or Off)
  and preview each one inline. It fires when any turn ends — the session you have open *or* a
  background one — except for turns you stop yourself.

When a turn finishes on a session you're not currently viewing, the sidebar marks it with a
steady accent dot and a bold title until you open it.

## How it works

```
Browser (React + Vite)
   │  WebSocket  /ws  (seq‑tagged events, rAF‑coalesced)  +  /terminal  (PTY stream)
   ▼
Vibe server (Node + Express + ws)
   │  local: Claude SDK → `claude`; Codex / Cursor / Kimi / Kiro structured CLI output
   │  remote: ssh → selected agent CLI on the host        terminal: node-pty (local shell / ssh -tt)
   ▼
Agent CLI  (runs in your chosen directory; history is read from native stores or Vibe transcripts)
```

- **`shared/protocol.ts`** — the single source of truth for the wire protocol.
- **`server/`** — token auth, agent runners (Claude SDK plus Codex/Cursor/Kimi/Kiro CLI runners,
  local or remote over `ssh`, all normalized into the same block stream), a per‑session
  event hub (seq log, replay, backpressure), a session metadata store, transcript readers
  for history, discovery of existing Claude/Codex/Cursor/Kimi/Kiro sessions where available, the
  MCP server registry (per‑scope enable lists + OAuth token management), saved session presets,
  chat‑attachment upload, an optional Telegram bot, and the terminal PTY channel. Deleting a
  discovered session only dismisses it from Vibe — the underlying agent transcript is never touched.
- **`web/`** — the WebSocket client (reconnect + coalescing), a Zustand store with a block
  reducer, and the UI: chat with file attachments, sidebar (sessions, hosts, search, unread
  markers), terminal & files panels, the agent todo list, and Settings (MCP servers, presets,
  completion sound).

## Security

- All HTTP and WebSocket traffic requires the access token.
- Vibe can run arbitrary tools through the selected agent CLI on your machine — only expose it on
  networks you trust, and prefer a tunnel over opening a public port.
- Permission prompts and tool policies follow each agent's supported permission model.

## License

MIT
