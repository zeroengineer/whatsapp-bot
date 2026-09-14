import { UserError } from '../core/types.js';
import { sleep } from '../utils/retry.js';

export type OperationKind = 'removal' | 'leave';

export interface RunningInfo {
  kind: OperationKind;
  opId: string;
  groupName: string;
  groupIndex: number;
  groupCount: number;
  total: number;
  processed: number;
}

export interface RunningOperation extends RunningInfo {
  cancelRequested: boolean;
  done: Promise<void>;
}

/**
 * Ensures at most ONE destructive operation (removal or leave) runs at a time,
 * and carries its progress and cancellation flag.
 */
export class OperationLock {
  private current: (RunningOperation & { finish: () => void }) | undefined;

  acquire(info: Omit<RunningInfo, 'processed'>): RunningOperation {
    if (this.current) {
      const what = this.current.kind === 'leave' ? 'A leave operation' : 'A removal';
      throw new UserError(`${what} is already running in "${this.current.groupName}". Wait for it to finish.`);
    }
    let finish!: () => void;
    const done = new Promise<void>((r) => (finish = r));
    this.current = { ...info, processed: 0, cancelRequested: false, done, finish };
    return this.current;
  }

  release(op: RunningOperation): void {
    if (this.current !== op) return;
    const { finish } = this.current;
    this.current = undefined;
    finish();
  }

  get(): RunningInfo | undefined {
    if (!this.current) return undefined;
    const { kind, opId, groupName, groupIndex, groupCount, total, processed } = this.current;
    return { kind, opId, groupName, groupIndex, groupCount, total, processed };
  }

  /** Ask the running operation to stop at the next safe point. Returns false if nothing is running. */
  requestCancel(): boolean {
    if (!this.current) return false;
    this.current.cancelRequested = true;
    return true;
  }

  /** Resolves true when idle, or false if still running after `timeoutMs`. */
  async waitForIdle(timeoutMs: number): Promise<boolean> {
    if (!this.current) return true;
    const done = this.current.done.then(() => true);
    return Promise.race([done, sleep(timeoutMs).then(() => !this.current)]);
  }
}
