export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Reject if `promise` does not settle within `ms`. The underlying work is not cancelled. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Exponential backoff with full jitter, capped. attempt starts at 0. */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number, random: () => number = Math.random): number {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(exp / 2 + random() * (exp / 2));
}

/** Extract an HTTP-like status code from Baileys (Boom) errors or our own errors. */
export function errorStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { output?: { statusCode?: number }; statusCode?: number; data?: { statusCode?: number } };
  return e.output?.statusCode ?? e.statusCode ?? e.data?.statusCode;
}

/** Short, non-sensitive description of an error, safe to show in WhatsApp replies. */
export function describeError(err: unknown): string {
  if (err instanceof TimeoutError) return 'request timed out';
  const code = errorStatusCode(err);
  if (code !== undefined) return `WhatsApp error ${code}`;
  return 'unexpected error';
}
