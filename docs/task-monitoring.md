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

Example Airflow probe:

```sh
python3 scripts/check_airflow_health.py
```

The script should print a concise diagnosis and exit non-zero only when agent
action is needed. Keep credentials in the host's environment/configuration,
never in the monitor command or runbook.

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

## HTTP API

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
