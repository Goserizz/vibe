#!/usr/bin/env bash
# Claude-over-SSH tunnel for the Agent SDK.
#
# Vibe points the SDK's `pathToClaudeCodeExecutable` here for remote (SSH) sessions.
# The SDK spawns this script as if it were `claude` (args in "$@"), talking stream-json
# over stdin/stdout. We forward the invocation to the remote host's `claude` over SSH,
# so the SDK's full control protocol (canUseTool / request_user_dialog) runs remotely —
# giving remote sessions the same interactive prompts (per-tool Allow/Deny, the
# AskUserQuestion picker, ExitPlanMode) as local.
#
# Config comes via env (set by runner.ts) so one script serves every host:
#   VIBE_SSH_TARGET   user@host or ssh Host alias          (required)
#   VIBE_REMOTE_CWD   absolute path to `cd` into remotely   (optional)
#   VIBE_SSH_BIN      ssh binary                             (default: ssh)
#   VIBE_SSH_OPTS     ssh options, space-separated           (BatchMode, LogLevel=ERROR, …)
set -u

: "${VIBE_SSH_TARGET:?VIBE_SSH_TARGET not set}"
ssh_bin="${VIBE_SSH_BIN:-ssh}"

# Build the remote command: cd to the remote cwd, then run claude with the forwarded
# args. `printf %q` safely quotes each token for the remote POSIX shell.
full="claude $(printf '%q ' "$@")"
if [ -n "${VIBE_REMOTE_CWD:-}" ]; then
  full="cd $(printf '%q' "$VIBE_REMOTE_CWD") && $full"
fi

# Run it through the user's remote login+interactive shell so version managers
# (nvm/fnm/volta/…) put `claude` on PATH. `\${SHELL:-bash}` is escaped so the
# LOCAL wrapper leaves it literal, then the REMOTE shell expands it (mirrors
# loginShellCommand in remote/ssh.ts — it must NOT be quoted, or the remote
# shell would try to run a command literally named `${SHELL:-bash}`).
remote="\${SHELL:-bash} -lic $(printf '%q' "$full")"

# VIBE_SSH_OPTS is intentionally unquoted — it word-splits into individual -o opts.
# shellcheck disable=SC2086
exec "$ssh_bin" ${VIBE_SSH_OPTS} -T "$VIBE_SSH_TARGET" "$remote"
