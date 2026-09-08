# Global skill deployment

Settings → Skills now opens **Global · all hosts** by default. A global skill
has one centrally saved definition and is deployed to every host owned by the
current account. Admin definitions also include the Vibe server's local user.
Other accounts' hosts are never deployment targets, including for admin.

## Create, edit, or promote

1. Select **Add global skill** and enter the name, description, optional
   `whenToUse`, and Markdown instructions.
2. Choose target agents; a new skill defaults to all ten supported agents.
3. Save. The API returns after persisting the definition, without waiting for
   SSH. Deployment continues in the background.
4. Expand **Deployment details** to see each host × agent result. **Retry
   deployment** requests another attempt immediately.

Use **This host only** for the previous host-local editing workflow. Its globe
button reads an existing personal skill into the global creation form; saving
that form explicitly promotes it. System/plugin skills remain read-only and
are not automatically copied or promoted.

Statuses are `pending`, `synced`, `conflict`, and `failed`. `synced` means the
native `SKILL.md` is present and matches the managed definition; it does not
claim the CLI is installed or that the skill's external services are healthy.
Some already-running CLIs need a new turn or restart to discover added skills.

## Synchronization and recovery

Definitions and per-target revision/provenance are stored in
`~/.vibe/global-skills.json`, written atomically with mode `0600`. The file can
contain credentials embedded in skill bodies: never commit it or print it in
diagnostics. List responses omit bodies; detail reads and all mutations are
account-scoped. A corrupt registry fails closed instead of being overwritten.

The scheduler starts with Vibe, handles up to three host jobs concurrently,
and batches an individual skill's agent paths into each host operation. It
persists failures and retries them about once a minute. New or changed hosts
trigger reconciliation immediately. Successful targets are checked again
every fifteen minutes; conflicts are rechecked every five minutes. The retry
button bypasses those delays. No agent turn needs to keep the scheduler alive.

Paths use each target's login-user HOME and the existing agent-specific skill
layout. A working POSIX shell and `python3` are required on deployment hosts.
The same file transport is used locally and remotely; skill contents are sent
through stdin rather than command arguments. Missing CLI directories may be
created so a later CLI installation can discover the skill.

## Protecting existing files

- An existing semantically matching skill is adopted without rewriting it.
- Updates preserve unknown frontmatter fields and only replace files whose
  current hash matches the last installed/adopted hash.
- Different unmanaged files and subsequent manual edits produce a conflict.
  Enable **Replace conflicting same-name skills** when saving a new revision
  to explicitly replace those initial conflicts. This permission is not a
  perpetual overwrite policy: later manual edits still require confirmation.
- Changed files are backed up as `.SKILL.md.vibe-backup-*` in the skill folder.
  Writes use a file lock, compare-and-swap check, private temporary file and
  atomic rename. Symbolic-link targets are refused for manual review.

Native copies are intentionally retained when an agent is deselected or
**Stop global synchronization** is used. Stopping removes the central definition
and prevents future deployment; it does not delete existing native files or
interrupt conversations. Remove unwanted copies explicitly in host-local
management afterward. Deleting a native copy while its global definition is
still active causes it to be restored on a later check.

This feature distributes the `SKILL.md` authored by Vibe's form, not arbitrary
companion scripts/assets or entire plugin packages. Referenced helper files and
external credentials/services still need to exist on the target host.

## Validation

The global deployment suite covers ten-agent paths, durable/private storage,
offline/restart recovery, new-host triggers, revision races, conflicts and
one-revision replacement permission, preserved frontmatter, native backups/CAS,
symlink/traversal protection, SSH stdin transport, and account/API isolation.
Account deletion clears its definitions before the identity can be recreated.
All automated tests use synthetic content and temporary directories or injected
IO. No test deploys to real CLI homes or remote hosts.
