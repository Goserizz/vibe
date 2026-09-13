# ZCode model configuration and safe MCP updates

An installed ZCode binary, a selected model name, and a working MCP server do
not establish model-provider access. A config containing only `mcp.servers`
is insufficient for a new ZCode session. Configure the provider and default
`model.main` (and optional `model.lite`) on the host/user running ZCode. Keep
provider credentials out of repository files, prompts, diagnostics and logs.

Vibe now uses only `Auto` while no configured ZCode model list is available;
neither the server nor the frontend invents GLM candidates for an unconfigured
host. A confirmed MCP-only/missing user config produces an actionable startup
error before launching a fresh CLI session. Existing-session runtime-model
compatibility is preserved. Project config and environment/dotenv overrides
are left to the native resolver instead of being incorrectly rejected by a
user-config-only check.

Desktop ZCode 3.12+ loads models from `~/.zcode/v2/provider_config.json`.
`zcode app-server` does not import `~/.zcode/cli/config.json` on its own.
Vibe projects the host's existing `provider` / `model.main` into that personal
file before starting a turn, without removing providers created in the TUI.
Keep credentials out of logs; the writer only reports path and counts.
Selecting GLM-5.3 also requires a reasoning level (`low|high|max`); Vibe
sends it on `session/setModel` from the session effort (or the model default).

## MCP reconciliation

MCP updates are performed in one on-host transaction using `python3`:

- Read and validate the current config on that host, while holding a file lock.
- Preserve provider/model, network, plugin and user-managed MCP settings.
- Remove only MCP names recorded in Vibe's sidecar, then merge the desired set.
- Recheck file bytes immediately before an atomic rename to avoid replacing
  a configuration edited during the operation.
- Write config and sidecar using private `0600` temporary files. Keep a
  recoverable `config.json.vibe-backup-*` snapshot per non-MCP configuration,
  so rotating Monitor capabilities does not generate unbounded duplicate backups.

A missing config is not created as an MCP-only stub. SSH/read failures, invalid
JSON, non-object config/MCP sections and symlink files are not converted into
empty objects. Failed best-effort reconciliation leaves the config intact and
logs a bounded diagnostic; the native CLI remains responsible for validation
when inspection is unavailable. Python must be available for this MCP update
path. The MCP payload travels through stdin; provider secrets are not downloaded
just to edit MCP settings.

## Recovery

Back up the affected host's file first. Merge only the intended provider and
model defaults from a verified, authorized source, preserving its existing MCP
and host-specific settings. Do not overwrite the entire file with another
machine's config. This is separate from global skill deployment, which copies
only skill definitions, not model credentials.

The old MCP implementation treated a failed remote read like a missing file;
that unsafe fallback has been removed. This establishes a potential overwrite
path, not proof that it caused any particular historical configuration loss.

## Verification (2026-09-07)

The tested ZCode 0.16.5 build successfully created a new session and completed
a GLM-5.3 prompt returning the synthetic marker `VIBE_CONFIG_OK`, with zero tool
calls. `ZCODE_STORAGE_DIR`, `ZCODE_SESSION_DB_PATH` and a temporary project
configuration isolated all test session data. SQLite integrity passed and the
test session was absent from the real database; temporary data was removed.

That build advertised `--settings` in help but rejected it in the headless
parser, so verification used the same app-server protocol as Vibe. Empty
sessions may not be persisted until the first turn; a missing row immediately
after `session/create` is not itself a failed creation.

Fifteen regression cases cover config preservation, missing/corrupt/read-failed
inputs, on-host merging, concurrent updates and backups, private permissions,
project overrides, model-list defaults, fresh-session preflight, resume
compatibility and cancellation during preflight. All use synthetic inputs,
temporary files or injected IO, not production configs.
