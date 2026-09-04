/**
 * Assert vibot multimodal message body shaping (no network).
 * Run: npx tsx server/src/vibot/llm.images.selftest.ts
 */
import { buildUserContent, type LlmMessage } from './llm.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function bodyMessages(messages: LlmMessage[]) {
  // Mirror what streamChat puts in the request body for the messages field.
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.name ? { name: m.name } : {}),
  }));
}

// 1) Pure text stays a string (not an array).
const textOnly = buildUserContent('hello');
assert(textOnly === 'hello', 'text-only must remain a string');
assert(typeof bodyMessages([{ role: 'user', content: textOnly }])[0]!.content === 'string', 'body content string');

// 2) With images → content parts array.
const url = 'data:image/png;base64,aaaa';
const multi = buildUserContent('look', [url]);
assert(Array.isArray(multi), 'with images must be an array');
assert(JSON.stringify(multi) === JSON.stringify([
  { type: 'text', text: 'look' },
  { type: 'image_url', image_url: { url } },
]), 'image_url part shape');

const serialized = JSON.stringify(bodyMessages([{ role: 'user', content: multi }]));
assert(serialized.includes('"image_url"') && serialized.includes(url), 'serialized body has image_url');

// 3) Text-only body shape unchanged vs classic message.
const classic = JSON.stringify({ role: 'user', content: 'hello' });
const shaped = JSON.stringify(bodyMessages([{ role: 'user', content: buildUserContent('hello') }])[0]);
assert(classic === shaped, 'classic text body must match pre-vision shape');

console.log('PASS vibot multimodal body shaping');
