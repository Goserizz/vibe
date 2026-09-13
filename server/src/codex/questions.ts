import { z } from 'zod';
import type { AgentQuestionItem } from '../../../shared/protocol.js';

export const asyncQuestionItemsSchema = z.array(z.object({
  title: z.string().trim().min(1).max(16_384),
  options: z.array(z.string().trim().min(1).max(2_048)).max(64).nullish(),
})).min(1).max(20).refine(items => Buffer.byteLength(JSON.stringify(items)) <= 65_536, 'Question form is too large').transform(items => items.map(({ title, options }) => ({
  title, ...(options?.length ? { options: [...new Set(options)] } : {}),
})));

/** v0.153.4 ThreadItem.agentMessage: delivery=async, questions[].
 * Plain markdown questions and rollout function_call records are NOT input
 * requests: only live typed messages can create Vibe's pending-question state. */
export function parseCodexAsyncQuestion(item: unknown): { id: string; questions: AgentQuestionItem[] } | null {
  if (!item || typeof item !== 'object') return null;
  const value = item as Record<string, unknown>;
  if (!['agentMessage', 'agent_message'].includes(String(value.type)) || value.delivery !== 'async') return null;
  if (typeof value.id !== 'string' || !value.id || value.id.length > 512) return null;
  const result = asyncQuestionItemsSchema.safeParse(value.questions);
  return result.success ? { id: value.id, questions: result.data } : null;
}
