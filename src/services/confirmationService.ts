import { randomUUID } from 'node:crypto';
import type { ConfirmToken } from '../core/parser.js';
import { describeOperation, UserError, type OperationType, type PendingOperation } from '../core/types.js';

export const tokenFor = (type: OperationType): ConfirmToken => (type === 'removeall' ? 'CONFIRM REMOVEALL' : 'CONFIRM');

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

  create(input: Omit<PendingOperation, 'id' | 'createdAt' | 'expiresAt'>): PendingOperation {
    const existing = this.getPending();
    if (existing) {
      throw new UserError(
        `Another operation is already pending (${describeOperation(existing)}).\n` +
          `Reply ${tokenFor(existing.type)} to run it, or !cancel to discard it.`,
      );
    }
    const createdAt = this.now();
    this.pending = { ...input, id: randomUUID().slice(0, 8), createdAt, expiresAt: createdAt + this.ttlMs };
    return this.pending;
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
