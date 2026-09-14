import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const ConfigSchema = z.object({
  OWNER_PHONE: z
    .string({ error: 'OWNER_PHONE is required' })
    .transform((v) => v.replace(/[\s+\-()]/g, ''))
    .pipe(z.string().regex(/^\d{7,15}$/, 'OWNER_PHONE must be 7–15 digits in international format, e.g. 919876543210')),
  COMMAND_PREFIX: z.string().min(1).max(3).default('!'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  DRY_RUN: booleanString.default(false),
  AUTH_METHOD: z.enum(['qr', 'pairing']).default('qr'),
  AUTH_DIR: z.string().default('./auth'),
  LOG_DIR: z.string().default('./logs'),
  DATA_DIR: z.string().default('./data'),
  CONFIRM_TTL_SECONDS: z.coerce.number().int().min(15).max(3600).default(120),
  REMOVE_BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(5),
  REMOVE_BATCH_DELAY_MS: z.coerce.number().int().min(0).max(600_000).default(3000),
  OPERATION_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(30_000),
});

export interface AppConfig {
  ownerPhone: string;
  commandPrefix: string;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  dryRun: boolean;
  authMethod: 'qr' | 'pairing';
  authDir: string;
  logDir: string;
  dataDir: string;
  confirmTtlMs: number;
  removeBatchSize: number;
  removeBatchDelayMs: number;
  operationTimeoutMs: number;
}

export class ConfigError extends Error {}

/**
 * Parses configuration from environment variables and CLI arguments.
 * `--dry-run` on the command line forces dry-run mode regardless of DRY_RUN.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): AppConfig {
  // Treat empty strings as "unset" so defaults apply.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const result = ConfigSchema.safeParse(cleaned);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.') || 'config'}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid configuration (check your .env file):\n${issues}`);
  }
  const c = result.data;
  return {
    ownerPhone: c.OWNER_PHONE,
    commandPrefix: c.COMMAND_PREFIX,
    logLevel: c.LOG_LEVEL,
    dryRun: c.DRY_RUN || argv.includes('--dry-run'),
    authMethod: c.AUTH_METHOD,
    authDir: path.resolve(c.AUTH_DIR),
    logDir: path.resolve(c.LOG_DIR),
    dataDir: path.resolve(c.DATA_DIR),
    confirmTtlMs: c.CONFIRM_TTL_SECONDS * 1000,
    removeBatchSize: c.REMOVE_BATCH_SIZE,
    removeBatchDelayMs: c.REMOVE_BATCH_DELAY_MS,
    operationTimeoutMs: c.OPERATION_TIMEOUT_MS,
  };
}
