import { z } from 'zod';
import { runnerSchema } from './runner-config.js';
import { iterationSchema } from './iteration.js';
import { serviceSchema } from './service.js';
import { decisionSchema } from './decision.js';

export const configSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  dataDir: z.string().default('.repopilot-data'),
  pollSeconds: z.number().int().min(15).default(60),
  iteration: iterationSchema.optional(),
  service: serviceSchema.optional(),
  decision: decisionSchema.optional(),
  runner: runnerSchema.optional(),
  agent: z.object({
    enabled: z.boolean().default(false),
    repair: z.boolean().default(false),
    image: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/).default('repopilot-agent:local'),
    model: z.string().min(1).optional(),
    timeoutSeconds: z.number().int().min(10).max(1800).default(300),
    maxAttempts: z.number().int().min(1).max(3).default(2),
    maxCalls: z.number().int().min(1).max(100).default(16),
    maxTokens: z.number().int().min(1000).default(200000)
  }).default({ enabled: false, repair: false, image: 'repopilot-agent:local', timeoutSeconds: 300, maxAttempts: 2, maxCalls: 16, maxTokens: 200000 }),
  retry: z.object({ attempts: z.number().int().min(1).max(5).default(3),
    baseDelayMs: z.number().int().min(0).default(1000), maxDelayMs: z.number().int().min(1).default(30000),
    maxTaskExecutions: z.number().int().min(1).max(5).default(3)
  }).default({ attempts: 3, baseDelayMs: 1000, maxDelayMs: 30000, maxTaskExecutions: 3 }),
  taskTimeoutSeconds: z.number().int().min(1).max(7200).default(1800),
  freshnessSeconds: z.number().int().min(1).max(300).default(15),
  publish: z.boolean().default(false)
}).strict();
export type Config = z.infer<typeof configSchema>;
