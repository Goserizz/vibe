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
#   VIBE_ERR_LOG      path to capture remote stderr into      (set by runner.ts on
#                     remote turns; read on non-zero exit to surface why claude failed)
set -u

: "${VIBE_SSH_TARGET:?VIBE_SSH_TARGET not set}"
ssh_bin="${VIBE_SSH_BIN:-ssh}"

# Build the remote claude command from the forwarded args. `printf %q` safely
# quotes each token for the remote POSIX shell.
claude_cmd="claude $(printf '%q ' "$@")"

# The SDK passes Vibe's "bypassPermissions" choice as `--permission-mode
# bypassPermissions`, which claude expands to a total permission bypass — and
# then REFUSES to run as root/sudo (common for Vibe hosts), exiting 1. Vibe is
# the controller/sandbox for these runs, so signal that with IS_SANDBOX=1: the
# only override claude accepts for root bypass (--allow-dangerously-skip-permissions
# does not). Applied solely when bypass mode is actually requested, so normal
# (prompted) turns are untouched. Handles both `--permission-mode bypassPermissions`
# and the `--permission-mode=bypassPermissions` forms.
sandbox=""
prev=""
for a in "$@"; do
  if [ "$a" = "bypassPermissions" ] && [ "$prev" = "--permission-mode" ]; then
    sandbox="IS_SANDBOX=1"
    break
  fi
  case "$a" in --permission-mode=bypassPermissions) sandbox="IS_SANDBOX=1"; break ;; esac
  prev="$a"
done
[ -n "$sandbox" ] && claude_cmd="$sandbox $claude_cmd"

# cd into the remote cwd, then run claude.
if [ -n "${VIBE_REMOTE_CWD:-}" ]; then
  full="cd $(printf '%q' "$VIBE_REMOTE_CWD") && $claude_cmd"
else
  full="$claude_cmd"
fi

# Run it through the user's remote login+interactive shell so version managers
# (nvm/fnm/volta/…) put `claude` on PATH. `\${SHELL:-bash}` is escaped so the
# LOCAL wrapper leaves it literal, then the REMOTE shell expands it (mirrors
# loginShellCommand in remote/ssh.ts — it must NOT be quoted, or the remote
# shell would try to run a command literally named `${SHELL:-bash}`).
remote="\${SHELL:-bash} -lic $(printf '%q' "$full")"

# Capture remote stderr to a side-channel file when runner.ts provides one
# (VIBE_ERR_LOG). The Agent SDK's thrown error on a non-zero exit carries only
# the code ("Claude Code process exited with code 1"), not the remote stderr —
# so we stash it for the runner to read and surface. stdout is never touched:
# the stream-json protocol must stay clean. `exec` keeps the wrapper replaced by
# ssh, so the SDK's abort/signals still reach ssh directly. When run manually
# (no VIBE_ERR_LOG) stderr flows to the terminal as usual for debugging.
if [ -n "${VIBE_ERR_LOG:-}" ]; then
  # shellcheck disable=SC2086
  exec "$ssh_bin" ${VIBE_SSH_OPTS} -T "$VIBE_SSH_TARGET" "$remote" 2>"$VIBE_ERR_LOG"
else
  # shellcheck disable=SC2086
  exec "$ssh_bin" ${VIBE_SSH_OPTS} -T "$VIBE_SSH_TARGET" "$remote"
fi
