/**
 * WhatsApp connection & authentication (Baileys).
 *
 * Responsibilities: session persistence, QR / pairing-code linking, connection lifecycle,
 * reconnection with backoff, and emitting raw incoming messages. No business logic here.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
  type Contact,
  type WASocket,
} from 'baileys';
import qrcode from 'qrcode-terminal';
import type { AppConfig } from '../config.js';
import type { Logger } from '../utils/logger.js';
import { normalizeJid, splitJid } from '../utils/permissions.js';
import { backoffDelay, errorStatusCode, withTimeout } from '../utils/retry.js';
import type { ConnectionStatus, IncomingMessage, SelfInfo } from './client.js';
import type { LastMessageIndex } from './messageIndex.js';
import { toIncomingMessage } from './messages.js';

/** Disconnect reasons after which reconnecting would be wrong or futile. */
const FATAL_REASONS: Record<number, string> = {
  [DisconnectReason.loggedOut]: 'Logged out from WhatsApp. Delete the auth directory and link the device again.',
  [DisconnectReason.connectionReplaced]: 'Connection replaced: another session using these credentials was opened.',
  [DisconnectReason.forbidden]: 'WhatsApp refused the connection (403). The bot will not retry.',
  [DisconnectReason.multideviceMismatch]: 'Multi-device mismatch (411). Re-link the device.',
};

export interface ConnectionEvents {
  message: [IncomingMessage];
  status: [ConnectionStatus];
  /** Unrecoverable condition; the application should shut down. */
  fatal: [string];
}

export class WhatsAppConnection extends EventEmitter<ConnectionEvents> {
  private sock: WASocket | undefined;
  private status: ConnectionStatus = 'closed';
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private authState: Awaited<ReturnType<typeof useMultiFileAuthState>> | undefined;
  /** Display names learned from contact events, keyed by normalized JID. */
  readonly contactNames = new Map<string, string>();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly messageIndex?: LastMessageIndex,
  ) {
    super();
  }

  getSocket(): WASocket | undefined {
    return this.status === 'open' ? this.sock : undefined;
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getSelf(): SelfInfo | undefined {
    const user = this.sock?.user;
    if (!user?.id) return undefined;
    const pn = splitJid(user.id);
    if (!pn) return undefined;
    return {
      phoneNumber: pn.user,
      pnJid: normalizeJid(user.id),
      lidJid: user.lid ? normalizeJid(user.lid) : undefined,
      name: user.name ?? user.notify ?? undefined,
    };
  }

  async start(): Promise<void> {
    this.stopped = false;
    fs.mkdirSync(this.config.authDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.config.authDir, 0o700);
    } catch {
      /* best effort on filesystems without POSIX permissions */
    }
    this.authState = await useMultiFileAuthState(this.config.authDir);
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const sock = this.sock;
    this.sock = undefined;
    this.setStatus('closed');
    if (sock) {
      // end() closes the socket but keeps the session; logout() would unlink the device.
      sock.end(undefined);
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  private async connect(): Promise<void> {
    if (this.stopped || !this.authState) return;
    const { state, saveCreds } = this.authState;
    const baileysLogger = this.logger.child({ module: 'baileys' }, { level: 'warn' });

    const { version, isLatest } = await withTimeout(fetchLatestBaileysVersion(), 10_000, 'fetch WA version').catch(() => ({
      version: undefined,
      isLatest: false,
    }));
    this.logger.debug({ version, isLatest }, 'Using WhatsApp Web version');

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, baileysLogger) },
      logger: baileysLogger,
      browser: Browsers.macOS('Desktop'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      defaultQueryTimeoutMs: this.config.operationTimeoutMs,
    });
    this.sock = sock;
    this.setStatus('connecting');
    let pairingRequested = false;

    // Every handler ignores events from a socket that has since been replaced.
    const isCurrent = () => this.sock === sock;

    sock.ev.on('creds.update', () => {
      saveCreds().catch((err: unknown) => this.logger.error({ err: String(err) }, 'Failed to persist session'));
    });

    sock.ev.on('connection.update', (update) => {
      if (!isCurrent()) return;
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        if (this.config.authMethod === 'pairing') {
          if (!pairingRequested && !state.creds.registered) {
            pairingRequested = true;
            sock
              .requestPairingCode(this.config.ownerPhone)
              .then((code) => {
                // Printed to the terminal only; never written to the log file.
                process.stdout.write(
                  `\nWhatsApp pairing code: ${code}\nOn your phone: WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead.\n\n`,
                );
              })
              .catch((err: unknown) => this.logger.error({ status: errorStatusCode(err) }, 'Could not request pairing code'));
          }
        } else {
          process.stdout.write('\nScan this QR code: WhatsApp → Settings → Linked devices → Link a device\n');
          qrcode.generate(qr, { small: true });
          this.logger.info('QR code displayed in terminal (expires shortly; a new one appears automatically)');
        }
      }

      if (connection === 'open') {
        this.reconnectAttempt = 0;
        this.setStatus('open');
        const self = this.getSelf();
        this.logger.info({ account: self?.phoneNumber }, 'WhatsApp connection open');
      }

      if (connection === 'close') {
        const code = errorStatusCode(lastDisconnect?.error);
        this.sock = undefined;
        const fatal = code !== undefined ? FATAL_REASONS[code] : undefined;
        if (fatal) {
          this.setStatus(code === DisconnectReason.loggedOut ? 'logged_out' : 'closed');
          this.logger.error({ code }, fatal);
          this.emit('fatal', fatal);
          return;
        }
        this.setStatus('closed');
        if (this.stopped) return;
        const delay = code === DisconnectReason.restartRequired ? 0 : backoffDelay(this.reconnectAttempt++, 1000, 60_000);
        this.logger.warn({ code, delayMs: delay, attempt: this.reconnectAttempt }, 'WhatsApp connection closed; reconnecting');
        this.reconnectTimer = setTimeout(() => {
          this.connect().catch((err: unknown) => {
            this.logger.error({ err: String(err) }, 'Reconnect failed');
            this.scheduleRetryAfterFailure();
          });
        }, delay);
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (!isCurrent()) return;
      // Track the newest message key per group (all upsert types, including system notices) for chat deletion.
      for (const raw of messages) this.messageIndex?.record(raw);
      // 'notify' = new live messages. 'append' covers our own sends and messages received while offline,
      // which must never be executed as commands.
      if (type !== 'notify') return;
      for (const raw of messages) {
        const msg = toIncomingMessage(raw);
        if (msg) this.emit('message', msg);
      }
    });

    sock.ev.on('messaging-history.set', ({ messages }) => {
      if (!isCurrent()) return;
      for (const raw of messages) this.messageIndex?.record(raw);
    });

    const rememberContacts =(contacts: Partial<Contact>[]) => {
      for (const c of contacts) {
        const name = c.name ?? c.notify ?? c.verifiedName;
        if (!name) continue;
        for (const id of [c.id, c.lid, c.phoneNumber]) {
          if (id && id.includes('@')) this.contactNames.set(normalizeJid(id), name);
        }
      }
    };
    sock.ev.on('contacts.upsert', rememberContacts);
    sock.ev.on('contacts.update', rememberContacts);
  }

  private scheduleRetryAfterFailure(): void {
    if (this.stopped) return;
    const delay = backoffDelay(this.reconnectAttempt++, 1000, 60_000);
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => this.scheduleRetryAfterFailure());
    }, delay);
  }

  waitForOpen(timeoutMs: number): Promise<boolean> {
    if (this.status === 'open') return Promise.resolve(true);
    return new Promise((resolve) => {
      const onStatus = (s: ConnectionStatus) => {
        if (s === 'open' || s === 'logged_out') {
          cleanup();
          resolve(s === 'open');
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off('status', onStatus);
      };
      this.on('status', onStatus);
    });
  }
}
