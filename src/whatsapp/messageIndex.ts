/**
 * Remembers the newest message key per GROUP chat.
 *
 * WhatsApp's "delete chat for me" action requires the key and timestamp of the chat's latest message,
 * and Baileys does not store messages. Only ids/timestamps are kept — never message content.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../utils/logger.js';

export interface IndexedMessageKey {
  id: string;
  remoteJid: string;
  fromMe: boolean;
  participant?: string;
}

export interface IndexedMessage {
  key: IndexedMessageKey;
  /** Seconds since epoch (WhatsApp resolution). */
  messageTimestamp: number;
}

/** Minimal shape of a Baileys WAMessage used here. */
export interface RawMessageLike {
  key?: { id?: string | null; remoteJid?: string | null; fromMe?: boolean | null; participant?: string | null } | null;
  messageTimestamp?: number | { toString(): string } | null;
}

const SAVE_DEBOUNCE_MS = 5000;

export class LastMessageIndex extends EventEmitter<{ updated: [string, IndexedMessage] }> {
  private readonly entries = new Map<string, IndexedMessage>();
  private saveTimer: NodeJS.Timeout | undefined;
  private dirty = false;

  constructor(
    private readonly filePath?: string,
    private readonly logger?: Logger,
  ) {
    super();
  }

  load(): void {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, IndexedMessage>;
      for (const [jid, entry] of Object.entries(data)) {
        if (LastMessageIndex.isValid(jid, entry)) this.entries.set(jid, entry);
      }
      this.logger?.debug({ count: this.entries.size }, 'Loaded last-message index');
    } catch (err) {
      this.logger?.warn({ err: String(err) }, 'Could not read last-message index; starting empty');
    }
  }

  private static isValid(jid: string, e: IndexedMessage | undefined): e is IndexedMessage {
    return (
      !!e &&
      jid.endsWith('@g.us') &&
      typeof e.key?.id === 'string' &&
      e.key.remoteJid === jid &&
      typeof e.messageTimestamp === 'number' &&
      e.messageTimestamp > 0 &&
      (e.key.fromMe || typeof e.key.participant === 'string')
    );
  }

  /**
   * Record a message if it is a group message with a complete key and is at least as new as the stored one.
   * Returns true if the index changed.
   */
  record(raw: RawMessageLike): boolean {
    const k = raw.key;
    const jid = k?.remoteJid ?? undefined;
    if (!k?.id || !jid || !jid.endsWith('@g.us')) return false;
    const ts = raw.messageTimestamp == null ? NaN : Number(typeof raw.messageTimestamp === 'number' ? raw.messageTimestamp : raw.messageTimestamp.toString());
    const entry: IndexedMessage = {
      key: { id: k.id, remoteJid: jid, fromMe: k.fromMe === true, ...(k.participant ? { participant: k.participant } : {}) },
      messageTimestamp: ts,
    };
    if (!LastMessageIndex.isValid(jid, entry)) return false;

    const existing = this.entries.get(jid);
    if (existing && existing.messageTimestamp > ts) return false;
    if (existing && existing.key.id === entry.key.id) return false;
    this.entries.set(jid, entry);
    this.emit('updated', jid, entry);
    this.scheduleSave();
    return true;
  }

  get(groupJid: string): IndexedMessage | undefined {
    return this.entries.get(groupJid);
  }

  has(groupJid: string): boolean {
    return this.entries.has(groupJid);
  }

  /** Resolve with an entry whose timestamp is >= `sinceSeconds`, or undefined after `timeoutMs`. */
  waitForNewer(groupJid: string, sinceSeconds: number, timeoutMs: number): Promise<IndexedMessage | undefined> {
    const current = this.entries.get(groupJid);
    if (current && current.messageTimestamp >= sinceSeconds) return Promise.resolve(current);
    return new Promise((resolve) => {
      const onUpdate = (jid: string, entry: IndexedMessage) => {
        if (jid === groupJid && entry.messageTimestamp >= sinceSeconds) {
          cleanup();
          resolve(entry);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(undefined);
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off('updated', onUpdate);
      };
      this.on('updated', onUpdate);
    });
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (!this.filePath || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.flush();
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (!this.filePath || !this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.entries)), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
      this.dirty = false;
    } catch (err) {
      this.logger?.warn({ err: String(err) }, 'Could not save last-message index');
    }
  }
}
