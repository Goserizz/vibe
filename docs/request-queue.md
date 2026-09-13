# Requests after the current reply

All ten coding agents share a server-side request queue. While an agent is
replying, enter another prompt and press Enter or **Queue message**. The current
response continues unchanged; accepted requests run individually, in FIFO order,
after the preceding reply finishes. The existing Stop button remains available.
Ordinary chat and CLI view use the same behavior. This does not change Vibot's
own chat-input behavior or the immediate handling of permission/question dialogs.

The **Next requests** panel above the composer shows accepted queued requests,
unconfirmed sends, and rejected sends. You can remove a waiting request, pause
the queue without stopping the current reply, resume it, or retry a rejected
send. Attachments are uploaded to the original session's host first; their paths
are carried with the queued prompt even if another conversation is opened while
the upload is in progress.

## Completion and interruption

- Successful completion starts the next waiting request automatically.
- Stop or a terminal error pauses the remaining queue. Resume it explicitly
  after checking the previous result; prompts are not silently discarded.
- A recovered transient error followed by success does not pause the queue.
- Background-task-aware agents reuse their live connection after foreground
  completion. A closing connection is allowed to finish before launching a new
  runner; Vibe never starts competing native processes to drain the same queue.
- Pending user requests take priority over a Monitor's next automatic wake.
  A manually paused queue does not disable independent Monitor operation.
- Agent switching is blocked while a runner or an automatic queue is active.
  Pause the queue and let the current runner finish before switching; pending
  prompts remain attached to the stable Vibe session id.

Queued prompts do not appear in the transcript or reach the model until they
actually start. They therefore do not split the current assistant response or
become part of a conversation-history export before execution.

## Persistence and delivery

Queues live under `~/.vibe/request-queues/` on the Vibe server. Each session has
an atomically replaced `0600` file; native agent history is not rewritten to
store pending requests. Acceptance is saved before the WebSocket ACK. A recent
message-id ledger (512 ids per session) deduplicates unacknowledged reconnect
retries and prevents cancelled requests from reappearing.

Refresh/reconnect reloads the authoritative queue. An unconfirmed send is still
labelled **Sending…**, not **queued**; connection failures retain it for retry.
An explicitly rejected send remains visible and can be retried or discarded.

A service restart retains pending requests but pauses them. A request that was
claimed when the process stopped is marked **Interrupted**: it may already have
performed some work. Review/remove it, or explicitly choose **Continue interrupted
& resume queue**. Confirmed interrupted requests receive new transcript ids and
a short continuation message instead of resending the original prompt:

> 刚刚对话被中断了，请继续完成中断前尚未完成的任务。

The message includes at most 200 characters of task context, asks the agent to
check existing history/results and side effects before proceeding, and to ask
for missing information instead of guessing. Attachment paths and long pasted
prompts are not recopied. The queue keeps its original text privately for
reference and deduplication; a persisted `continuation` flag chooses the actual
dispatch text. Repeated interruptions reuse that original reference, without
nesting continuation messages. The queue UI previews the continuation text.

Requests that were only waiting are still sent unchanged. Connection retries
with the same message id are still deduplicated; native pre-output transport
retries are unchanged. No interrupted request is automatically continued on
restart, and no native history is rewritten. This applies to the shared coding
session queue, not to Vibot's independent chat-input workflow.

Vibe does not promise exactly-once external side effects across a process crash.

Limits: 20 waiting requests per session, 1 MiB of UTF-8 text per request, and
4 MiB across its queued/in-flight text. Larger material should be attached as
files. Validation/storage errors reject only the new request and preserve the
existing queue. Session visibility/ownership is checked for send, subscribe,
remove, pause, resume, and dispatch. Deleting a session also cancels its queue.
Removing a queued prompt does not delete files already uploaded with it.

Protocol additions: `send_ack`, `request_queue`, `subscribed.requestQueue`, and
the `queue_remove`, `queue_pause`, `queue_resume` client commands. Older clients
can continue sending ordinary idle prompts; the new client is deployed only
after the queue-capable backend has restarted.
The `hello.interruptedResumeVersion: 1` capability confirms that interrupted
requests use continuation notices; deployment verifies it before publishing
the updated continuation UI.

## Verification

38 isolated regression cases cover persistence, deduplication, all ten agent
dispatch branches, lifecycle boundaries, background transports, reconnects,
ownership, deletion, switching, and shutdown. The complete suite passes 590
tests with no skips. Browser checks exercise the actual WebSocket handler with
injected runners and a temporary Vibe home in Chromium/Firefox, chat/CLI mode:
FIFO, cancellation, Stop/resume, refresh, lost ACKs, attachment-upload target
stability, failure pause, restart review, rejected-send retry, and mobile layout.
No production agent/model call is made by these tests.

2026-09-11 continuation update: 19 additional regression cases cover short task
references, attachment handling, Unicode, unchanged unsent requests, repeated
interruptions, durable-save failure, and continuation dispatch through all ten
coding agents. The focused queue/prompt suite passes 57 tests; the complete suite
passes 652 tests with no skips. Typecheck/build and Chromium/Firefox × chat/CLI
browser checks pass, including the actual continuation text, a second
interruption, and FIFO delivery of the untouched next request. A normal-command
monitor test's startup budget was raised from 2s to 10s after diagnostics showed
an exit-0 command whose close handling was delayed beyond 2s; its separate 100ms
timeout case and all production monitor settings remain unchanged.
