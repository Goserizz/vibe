# Vibe task monitoring

Vibe Monitors are durable health checks that keep running independently of an
agent turn. Vibe owns scheduling, incident deduplication, repeated wakes, and
recovery checks; the agent handles an incident but never has to relaunch the
monitor itself.

## Create a monitor

Open the sidebar menu and choose **Monitoring**, then **New monitor**:

1. Pick the Vibe conversation that should receive notices and handle failures.
2. Choose an interval (minimum 10 seconds).
3. Configure a probe:
   - **Command** runs in the conversation's working directory and host. Exit 0
     means healthy; any other exit code means unhealthy.
   - **HTTP** accepts a 200–399 response by default and can additionally require
     a literal substring in the response body. For a remote conversation the
     request is made on that host through SSH.
4. Choose **Wake agent** or **Notify only** and write a runbook describing
   allowed actions and the evidence required for recovery.
5. Use **Test**. It executes the probe once but does not create an incident or
   enable the schedule. Vibe cannot prove an arbitrary command is read-only, so
   the command itself must be written as an observation-only check.
6. Save the draft, then click **Enable**. Enabling immediately runs the first
   real check.

Every Monitor attached to the open conversation also appears in the session's
right-hand task rail beside **Tasks** and **Background tasks** (and in the
compact composer stack on smaller screens). Expand a row to see the latest
result, next check, wake count, and open incident; the row also provides Run
now, pause/start, and full-settings controls.

The right-side pane and conversation-list badges use the same in-memory,
account-scoped definition snapshot. Incident history loads independently: an
events failure or delay cannot hide known monitors. Concurrent refreshes are
serialized and coalesced, but every completed valid snapshot is published even
when another refresh is queued. Switching conversations immediately filters
the cached definitions instead of blanking the pane while fetching again.

Each browser read has a 20-second deadline and is aborted on timeout. Initial
loading, definition errors, and event-history errors are shown in the pane with
a retry action; a failed refresh preserves the last good data. These are UI
read errors, not proof that a server-side monitor has stopped. Account changes
clear the shared snapshot, and session/account changes cancel old event reads.

Regression verification (2026-09-07): typecheck/build passed; 545 tests passed
with no skips, including 11 new request-lifecycle cases. Firefox and Chromium
browser checks cover a successful response arriving after the 15-second poll,
independently hanging event reads, visible timeouts/retry, retained snapshots,
cached session switching, deletion, compact layout, and light/dark CLI/chat UI.
Browser fault injection uses synthetic API/WS data, without running real probes.

Example Airflow probe:

```sh
python3 scripts/check_airflow_health.py
```

The script should print a concise diagnosis and exit non-zero only when agent
action is needed. Keep credentials in the host's environment/configuration,
never in the monitor command or runbook.

## Conversation list markers

Coding conversation rows show a separate Monitor badge beside the title,
including search results and linked coding sessions in Vibot:

- Green: at least one Monitor is enabled, even when the agent itself is idle.
- Amber: an enabled Monitor is firing or has a probe error. A recheck keeps
  the warning until a successful probe confirms recovery.
- Gray: all attached Monitors are paused or still drafts.
- A number appears when multiple Monitors are attached; the tooltip and
  accessible label give enabled/total and attention counts.

The marker is independent of the existing running, unread, background-task
and favorite indicators, so none of those is hidden by monitoring. It does not
change list ordering or enable a Monitor. Binding uses the stable Vibe session
id, so switching agents preserves the marker, while rebinding/deletion clears
the old conversation's marker.

The browser loads one account-scoped Monitor snapshot for the list and task pane,
without requiring the Monitoring panel to be opened or blocking app startup.
WebSocket changes and reconnection refresh it immediately; a single 30-second
refresh (15 seconds while a conversation is open) covers transient failures or
missed events. Concurrent requests are coalesced, and responses from a previous
login are discarded. The list is never coupled to incident-history availability.

## Incident lifecycle

One continuous unhealthy period produces one incident. Repeated polls update
that incident rather than generating duplicate alerts. A new incident is
created only after the probe has first recovered and then fails again.

When **Wake agent** is selected, Vibe delivers a bounded incident envelope to
the currently configured agent for the attached Vibe session. Switching that
conversation from one agent to another does not detach the monitor. If the
session is busy, the event stays queued. If the probe remains unhealthy, Vibe
wakes it again after the configured reminder interval, up to the attempt limit.
The unattended turn uses that session's existing permission mode: in an
interactive mode it may wait for approval, while fully unattended remediation
requires the user to have deliberately selected the agent's bypass/yolo mode.

An agent reply does not close the incident. Only a subsequent successful probe
does. Exhausting the wake budget changes the incident to `escalated` while the
health check itself remains enabled, so later recovery is still detected.

Definitions and events live in `~/.vibe/monitors.sqlite` (SQLite WAL). Due work
is leased; after a Vibe crash/restart, expired leases are reclaimed and enabled
monitors continue from persisted `next_check_at` state.

## Agent management tools

Local agent turns receive Vibe's built-in [Streamable-HTTP MCP server](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) named
`vibe-monitor`. The user has granted its agent-facing tools account-scoped
Monitor management authority:

- `monitor_list`
- `monitor_create` (enabled by default)
- `monitor_create_draft`
- `monitor_update`
- `monitor_start`
- `monitor_stop`
- `monitor_run_now`

A request such as “持续监控这个项目，每两分钟检查一次，失败时唤醒当前会话”
can therefore create and start the Monitor directly. The agent can later change
the probe/runbook/schedule, rebind it to another managed session in the same
account, pause it, restart it, or run an immediate check. Deletion remains a
deliberate UI/API operation and is not exposed to the agent MCP.

When `remindMinutes` is omitted, it defaults to the larger of five minutes and
`intervalMinutes`, ensuring a fresh verification probe always runs before the
next agent wake.

For an agent running on an SSH host, Vibe cannot safely guess a network address
that routes back to the server. Set the full externally reachable endpoint:

```sh
VIBE_MONITOR_MCP_URL=https://vibe.example.com/api/internal/monitor-mcp
```

Use HTTPS. Each turn receives a short-lived capability bound to its owner and
originating Vibe session; every target Monitor is checked against that owner,
and the capability stops working when the originating session is deleted. The
broad Vibe login token is never given to the agent. Without this setting,
remote monitors still work and can be managed in the UI, but the remote agent
will not receive the management tools.

### Codex HTTP authentication

Codex's TOML key is `mcp_servers.<name>.http_headers`, not `headers` (see the
[official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)).
Vibe uses that key for both scoped Monitor capabilities and OAuth HTTP headers.
The other engines retain their own native `headers` representation.

Before the 2026-09-05 fix, Vibe wrote `headers.Authorization`. Codex silently
ignored it, so a valid, unexpired capability still produced HTTP 401 during MCP
initialization. The message `invalid or expired monitor capability` does not
by itself distinguish an expired token from a missing Authorization header.

The managed block is regenerated before a new Codex run, including replacement
of the old field name and rotation of per-turn capabilities. User-authored
configuration outside Vibe's markers is preserved. Restart Vibe to load the
fix, then send a new message so Codex reloads its MCP configuration. This does
not enable, stop, rebind, or otherwise change any Monitor definition.

Five regression tests cover local/remote header serialization, legacy managed
block replacement, token rotation/cache behavior, and OAuth/stdio/public-HTTP
compatibility. These tests inject file IO and never touch real CLI config.
When inspecting `codex mcp get ... --json`, redact header values: the command
can include the capability itself, which must not be copied into logs or chat.

Remote CLI verification on 2026-09-05: Codex reported `authStatus: bearerToken`
and all seven Monitor tools via `mcpServerStatus/list`; `monitor_list` using
the effective CLI headers returned HTTP 200. No model prompt was sent and no
Monitor definition or existing conversation history was changed.

## HTTP API

For ZCode, MCP injection does not initialize model access. The safe on-host
updater preserves provider/model settings and never creates an MCP-only config
when the user config is absent; see [ZCode model configuration](zcode-model-configuration.md).

All normal routes use the existing Vibe bearer authentication and are scoped to
the current account:

| Route | Purpose |
|---|---|
| `GET /api/monitors` | List definitions and current health |
| `POST /api/monitors` | Create a disabled draft |
| `PUT /api/monitors/:id` | Replace editable configuration |
| `POST /api/monitors/test` | Test unsaved configuration |
| `POST /api/monitors/:id/enabled` | Enable or pause |
| `POST /api/monitors/:id/run` | Run a real check immediately |
| `GET /api/monitor-events` | List incident history |
| `DELETE /api/monitors/:id` | Delete definition and incidents |

## Current scope

The first version monitors healthy/unhealthy state through command or HTTP
probes. It does not yet include cron expressions, webhooks, output-change
events, secret references, approval policies independent of the attached
session, or an Airflow-specific probe/verifier. Those can be added without
changing the durable scheduler/event model.
