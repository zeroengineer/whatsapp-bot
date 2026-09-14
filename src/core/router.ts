/**
 * Message pipeline:
 *   incoming → dedupe → freshness → AUTHORIZE (owner self-chat only) → parse → dispatch → reply
 */
import { createCommandRegistry, handleConfirm } from '../commands/index.js';
import type { AppConfig } from '../config.js';
import { maskId, type Logger } from '../utils/logger.js';
import { isAuthorizedOwnerMessage } from '../utils/permissions.js';
import { describeError, TimeoutError, withTimeout } from '../utils/retry.js';
import { GroupNotFoundError, NotConnectedError, type IncomingMessage, type WhatsAppClient } from '../whatsapp/client.js';
import { parseInput } from './parser.js';
import { UserError, type BotState, type Command, type CommandContext, type Services } from './types.js';

/** Maximum characters per outgoing WhatsApp message; longer replies are split on line boundaries. */
export const MAX_MESSAGE_CHARS = 3500;
/** Ignore messages whose timestamp is this far in the past (replayed/old history). */
const MAX_MESSAGE_AGE_MS = 5 * 60_000;
/** Allowed clock skew between WhatsApp timestamps and the bot's startup time. */
const STARTUP_SKEW_MS = 10_000;
const COMMAND_TIMEOUT_MS = 90_000;
const SEEN_CAPACITY = 1000;

export function chunkMessage(text: string, max = MAX_MESSAGE_CHARS): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const pieces = line.length > max ? line.match(new RegExp(`.{1,${max}}`, 'g')) ?? [line] : [line];
    for (const piece of pieces) {
      if (current.length + piece.length + 1 > max && current) {
        chunks.push(current);
        current = '';
      }
      current = current ? `${current}\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Bounded insertion-ordered set. */
class RecentIds {
  private readonly ids = new Set<string>();
  constructor(private readonly capacity: number) {}
  has(id: string): boolean {
    return this.ids.has(id);
  }
  add(id: string): void {
    this.ids.add(id);
    if (this.ids.size > this.capacity) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
  }
}

export interface RouterDeps {
  wa: WhatsAppClient;
  config: AppConfig;
  logger: Logger;
  state: BotState;
  services: Services;
  now?: () => number;
  commands?: Map<string, Command>;
  commandTimeoutMs?: number;
}

export class CommandRouter {
  private readonly seen = new RecentIds(SEEN_CAPACITY);
  private readonly sentIds = new RecentIds(SEEN_CAPACITY);
  private readonly commands: Map<string, Command>;
  private readonly now: () => number;
  private accepting = true;

  constructor(private readonly deps: RouterDeps) {
    this.commands = deps.commands ?? createCommandRegistry();
    this.now = deps.now ?? Date.now;
  }

  stopAccepting(): void {
    this.accepting = false;
  }

  async handle(msg: IncomingMessage): Promise<void> {
    const { config, logger, wa, state } = this.deps;

    // 1. Duplicate delivery / our own replies.
    if (this.seen.has(msg.id) || this.sentIds.has(msg.id)) return;
    this.seen.add(msg.id);

    // 2. Authorization. Everything that is not the owner's self-chat is ignored silently.
    if (!isAuthorizedOwnerMessage(msg, wa.getSelf(), config.ownerPhone)) {
      if (msg.text.trim().startsWith(config.commandPrefix)) {
        logger.debug({ chat: maskId(msg.chatJid), sender: maskId(msg.senderJid) }, 'Ignored command from unauthorized chat/sender');
      }
      return;
    }

    // 3. Parse. Ordinary notes in the self-chat are not commands.
    const parsed = parseInput(msg.text, config.commandPrefix);
    if (parsed.kind === 'none') return;

    // 4. Freshness: never act on old messages (history replays, delayed deliveries).
    if (msg.timestamp < state.startedAt - STARTUP_SKEW_MS || this.now() - msg.timestamp > MAX_MESSAGE_AGE_MS) {
      logger.warn({ messageTs: msg.timestamp }, 'Ignored stale command message');
      return;
    }

    const replyTo = wa.getSelf()?.pnJid ?? msg.chatJid;
    const send = async (text: string) => {
      for (const chunk of chunkMessage(text)) {
        const id = await wa.sendText(replyTo, chunk);
        if (id) this.sentIds.add(id);
      }
    };

    if (!this.accepting) {
      await send('The bot is shutting down; command ignored.').catch(() => undefined);
      return;
    }

    const commandName = parsed.kind === 'confirm' ? parsed.token.toLowerCase().replace(' ', '_') : parsed.command.name;
    const command = parsed.kind === 'command' ? this.commands.get(parsed.command.name) : undefined;
    if (parsed.kind === 'command' && !command) {
      await send(`Unknown command "${config.commandPrefix}${parsed.command.name}". Send ${config.commandPrefix}help for the list.`).catch(
        (err: unknown) => logger.error({ err: describeError(err) }, 'Failed to send reply'),
      );
      return;
    }

    const ctx: CommandContext = {
      msg,
      command: parsed.kind === 'command' ? parsed.command : { name: commandName, args: '', dryRun: false },
      wa,
      config,
      logger: logger.child({ command: commandName }),
      state,
      services: this.deps.services,
      now: this.now,
      send,
    };

    logger.info({ action: 'command', command: commandName, args: ctx.command.args || undefined, dryRun: ctx.command.dryRun || undefined }, 'Owner command received');

    let reply: string;
    try {
      if (parsed.kind === 'confirm') {
        reply = await handleConfirm(ctx, parsed.token);
      } else {
        const run = command!.execute(ctx);
        reply = command!.longRunning ? await run : await withTimeout(run, this.deps.commandTimeoutMs ?? COMMAND_TIMEOUT_MS, commandName);
      }
    } catch (err) {
      reply = this.errorReply(err, commandName);
    } finally {
      state.lastCommand = { name: commandName, at: this.now() };
    }

    try {
      await send(reply);
    } catch (err) {
      logger.error({ command: commandName, err: describeError(err) }, 'Failed to send reply');
    }
  }

  private errorReply(err: unknown, commandName: string): string {
    const { logger } = this.deps;
    if (err instanceof UserError) {
      logger.info({ command: commandName, reason: err.message }, 'Command rejected');
      return err.message;
    }
    if (err instanceof NotConnectedError) return 'WhatsApp is not connected right now. Try again shortly.';
    if (err instanceof GroupNotFoundError) return 'That group could not be found or is no longer accessible.';
    if (err instanceof TimeoutError) {
      logger.warn({ command: commandName }, 'Command timed out');
      return 'The command timed out. WhatsApp may be slow; please try again.';
    }
    logger.error({ command: commandName, err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err) }, 'Command failed');
    return `Command failed (${describeError(err)}). Check the bot logs for details.`;
  }
}
