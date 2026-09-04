import { z } from 'zod';

const timeoutMs = z.number().int().min(1_000).max(5 * 60_000);

export const monitorProbeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('command'),
    command: z.string().trim().min(1).max(20_000),
    timeoutMs: timeoutMs.default(30_000),
  }),
  z.object({
    kind: z.literal('http'),
    url: z.string().url().max(4_096).refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === 'http:' || protocol === 'https:';
    }, { message: 'only http:// and https:// URLs are supported' }),
    method: z.enum(['GET', 'HEAD']).default('GET'),
    timeoutMs: timeoutMs.default(15_000),
    expectedStatusMin: z.number().int().min(100).max(599).default(200),
    expectedStatusMax: z.number().int().min(100).max(599).default(399),
    bodyIncludes: z.string().max(2_000).optional(),
  }).refine((value) => value.expectedStatusMin <= value.expectedStatusMax, {
    message: 'expectedStatusMin must be <= expectedStatusMax',
  }),
]);

export const monitorInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sessionId: z.string().trim().min(1).max(512).optional(),
  host: z.string().trim().min(1).max(120).optional(),
  cwd: z.string().trim().min(1).max(4_096).optional(),
  intervalMs: z.number().int().min(10_000).max(30 * 24 * 60 * 60_000),
  probe: monitorProbeSchema,
  actionMode: z.enum(['notify', 'wake-agent']),
  instructions: z.string().trim().max(10_000).default(''),
  maxWakeAttempts: z.number().int().min(1).max(20).default(3),
  remindEveryMs: z.number().int().min(30_000).max(30 * 24 * 60 * 60_000).default(5 * 60_000),
  notifyOnRecovery: z.boolean().default(true),
}).superRefine((value, ctx) => {
  if (value.actionMode === 'wake-agent' && !value.sessionId) {
    ctx.addIssue({
      code: 'custom',
      path: ['sessionId'],
      message: 'a session is required when actionMode is wake-agent',
    });
  }
  if (value.remindEveryMs < value.intervalMs) {
    ctx.addIssue({
      code: 'custom',
      path: ['remindEveryMs'],
      message: 'remindEveryMs must be greater than or equal to intervalMs so recovery is checked before another wake',
    });
  }
});

/** Arguments exposed to the model. Location/session identity is supplied by
 * the capability token and cannot be overridden by model output. */
export const monitorCreateDraftToolSchema = z.object({
  name: z.string().trim().min(1).max(120),
  objective: z.string().trim().min(1).max(10_000),
  intervalMinutes: z.number().min(1 / 6).max(30 * 24 * 60).default(5),
  probe: monitorProbeSchema,
  actionMode: z.enum(['notify', 'wake-agent']).default('wake-agent'),
  maxWakeAttempts: z.number().int().min(1).max(20).default(3),
  /** Omission is resolved by the MCP binding layer because the safe default
   * depends on intervalMinutes: max(5, intervalMinutes). */
  remindMinutes: z.number().min(0.5).max(30 * 24 * 60).optional(),
  notifyOnRecovery: z.boolean().default(true),
});

export type MonitorCreateDraftToolInput = z.infer<typeof monitorCreateDraftToolSchema>;

/** Full-power agent creation. `enabled:true` is intentional: the user opted in
 * to allowing the agent to start monitors without a second UI confirmation. */
export const monitorCreateToolSchema = monitorCreateDraftToolSchema.extend({
  enabled: z.boolean().default(true),
});

export const monitorUpdateToolSchema = z.object({
  monitorId: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(120).optional(),
  objective: z.string().trim().min(1).max(10_000).optional(),
  intervalMinutes: z.number().min(1 / 6).max(30 * 24 * 60).optional(),
  probe: monitorProbeSchema.optional(),
  actionMode: z.enum(['notify', 'wake-agent']).optional(),
  maxWakeAttempts: z.number().int().min(1).max(20).optional(),
  remindMinutes: z.number().min(0.5).max(30 * 24 * 60).optional(),
  notifyOnRecovery: z.boolean().optional(),
  /** Rebind to another already-managed Vibe session owned by the same account. */
  sessionId: z.string().trim().min(1).max(512).optional(),
}).refine((value) => Object.keys(value).some((key) => key !== 'monitorId'), {
  message: 'at least one monitor field must be changed',
});

export const monitorIdToolSchema = z.object({
  monitorId: z.string().trim().min(1).max(128),
});
