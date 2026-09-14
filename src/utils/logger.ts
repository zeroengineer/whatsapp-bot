import fs from 'node:fs';
import path from 'node:path';
import pino, { type Logger } from 'pino';

export type { Logger };

/** Keys whose values must never reach a log sink. */
export const REDACT_PATHS = [
  'creds',
  'keys',
  'auth',
  'token',
  'qr',
  'pairingCode',
  'session',
  '*.creds',
  '*.keys',
  '*.auth',
  '*.token',
  '*.qr',
  '*.pairingCode',
  '*.session',
];

export function createLogger(opts: { level: string; logDir: string; pretty?: boolean }): Logger {
  fs.mkdirSync(opts.logDir, { recursive: true, mode: 0o700 });
  const logFile = path.join(opts.logDir, 'bot.log');

  const targets: pino.TransportTargetOptions[] = [
    { target: 'pino/file', level: opts.level, options: { destination: logFile, mkdir: true } },
    opts.pretty === false
      ? { target: 'pino/file', level: opts.level, options: { destination: 1 } }
      : { target: 'pino-pretty', level: opts.level, options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' } },
  ];

  return pino(
    {
      level: opts.level,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.transport({ targets }),
  );
}

/** Silent logger for tests. */
export function createNullLogger(): Logger {
  return pino({ level: 'silent' });
}

/** Mask a phone number or JID for logs of non-owner activity: 919876543210 → 91******3210 */
export function maskId(id: string | undefined): string {
  if (!id) return 'unknown';
  const user = id.split('@')[0]?.split(':')[0] ?? '';
  if (user.length <= 6) return '***';
  return `${user.slice(0, 2)}${'*'.repeat(user.length - 6)}${user.slice(-4)}`;
}
