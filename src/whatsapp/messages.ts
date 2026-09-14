import { normalizeMessageContent, type WAMessage } from 'baileys';
import type { IncomingMessage } from './client.js';

/** Extract plain text from a Baileys message, or undefined for non-text messages. */
export function extractText(msg: WAMessage): string | undefined {
  const content = normalizeMessageContent(msg.message);
  if (!content) return undefined;
  const text = content.conversation ?? content.extendedTextMessage?.text ?? undefined;
  return typeof text === 'string' && text.trim() ? text : undefined;
}

/** Convert a Baileys message into the library-agnostic IncomingMessage. */
export function toIncomingMessage(msg: WAMessage): IncomingMessage | undefined {
  const key = msg.key;
  if (!key?.id || !key.remoteJid) return undefined;
  const text = extractText(msg);
  if (text === undefined) return undefined;
  const ts = msg.messageTimestamp;
  const seconds = typeof ts === 'number' ? ts : ts ? Number(ts.toString()) : Math.floor(Date.now() / 1000);
  return {
    id: key.id,
    chatJid: key.remoteJid,
    chatJidAlt: key.remoteJidAlt ?? undefined,
    fromMe: key.fromMe === true,
    senderJid: key.participant ?? (key.fromMe ? undefined : key.remoteJid),
    text,
    timestamp: seconds * 1000,
  };
}
