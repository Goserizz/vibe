/**
 * Checks for the shared transient-error matcher: cursor-agent's transport
 * failures ("RetriableError: [canceled] http/2 stream closed …" — the backend
 * gRPC stream being cancelled, often mid-turn) and the older 529 / internal
 * error / app-server / SSH texts all match, while ordinary hard failures
 * (command not found, syntax errors, permission denied) don't — misclassifying
 * those would send the runner into pointless retries.
 * Run: npx tsx scripts/retry-check.ts
 */
import assert from 'node:assert/strict';
import { mentionsTransient } from '../server/src/claude/retry.js';

// The exact msi incident text, plus case/shape variants of the same failure.
assert.ok(mentionsTransient('Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)'));
assert.ok(mentionsTransient('RetriableError: http2 stream closed'));
assert.ok(mentionsTransient('HTTP/2 stream closed with error code CANCEL'));

// Pre-existing transient classes must keep matching.
assert.ok(mentionsTransient('Error: 529 {"error":{"message":"model overloaded"}}'));
assert.ok(mentionsTransient('stream-json error: Internal error'));
assert.ok(mentionsTransient('app-server closed'));
assert.ok(mentionsTransient('kex_exchange_identification: Connection closed by remote host'));
assert.ok(mentionsTransient('访问量过大，请稍后重试'));
assert.ok(mentionsTransient('服务器过载'));

// Hard failures must stay non-transient.
assert.ok(!mentionsTransient('cursor-agent not found — install the Cursor CLI'));
assert.ok(!mentionsTransient('SyntaxError: Unexpected token } in JSON'));
assert.ok(!mentionsTransient('permission denied: /root/.cursor'));
assert.ok(!mentionsTransient('session not found'));

console.log('retry-check: all assertions passed');
