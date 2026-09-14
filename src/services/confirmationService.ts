import { randomUUID } from 'node:crypto';
import type { ConfirmToken } from '../core/parser.js';
import { describeOperation, UserError, type NewOperation, type OperationType, type PendingOperation } from '../core/types.js';

const TOKENS: Record<OperationType, ConfirmToken> = {
  remove: 'CONFIRM',
  removeall: 'CONFIRM REMOVEALL',
  leave: 'CONFIRM LEAVE',
};

export const tokenFor = (type: OperationType): ConfirmToken => TOKENS[type];

export type ConsumeResult =
  | { ok: true; op: PendingOperation }
  | { ok: false; reason: 'none' | 'expired' | 'wrong_token' | 'stale'; expected?: ConfirmToken };

/**
 * Holds at most ONE pending destructive operation.
 *
 * Safety properties:
 *  - a pending operation expires after `ttlMs`;
 *  - it is consumed atomically on the first valid confirmation (a repeated CONFIRM does nothing);
 *  - a confirmation message timestamped before the preview was created is rejected;
 *  - the confirmation token must match the operation type.
 */
export class ConfirmationService {
  private pending: PendingOperation | undefined;

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  getPending(): PendingOperation | undefined {
    if (this.pending && this.now() > this.pending.expiresAt) this.pending = undefined;
    return this.pending;
  }

  create<T extends NewOperation>(input: T): T & PendingOperation {
    const existing = this.getPending();
    if (existing) {
      throw new UserError(
        `Another operation is already pending (${describeOperation(existing)}).\n` +
          `Reply ${tokenFor(existing.type)} to run it, or !cancel to discard it.`,
      );
    }
    const createdAt = this.now();
    const op = { ...input, id: randomUUID().slice(0, 8), createdAt, expiresAt: createdAt + this.ttlMs } as T & PendingOperation;
    this.pending = op;
    return op;
  }

  cancel(): PendingOperation | undefined {
    const op = this.getPending();
    this.pending = undefined;
    return op;
  }

  consume(token: ConfirmToken, messageTimestampMs: number): ConsumeResult {
    const op = this.pending;
    if (!op) return { ok: false, reason: 'none' };
    if (this.now() > op.expiresAt) {
      this.pending = undefined;
      return { ok: false, reason: 'expired' };
    }
    // WhatsApp timestamps have 1-second resolution; compare at that granularity.
    if (Math.floor(messageTimestampMs / 1000) < Math.floor(op.createdAt / 1000)) {
      return { ok: false, reason: 'stale' };
    }
    const expected = tokenFor(op.type);
    if (token !== expected) return { ok: false, reason: 'wrong_token', expected };
    this.pending = undefined;
    return { ok: true, op };
  }
}
