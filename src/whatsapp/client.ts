/**
 * Library-agnostic WhatsApp interface.
 *
 * Commands and services depend ONLY on this file. The Baileys implementation lives in
 * ./connection.ts and ./groups.ts; tests use an in-memory fake.
 */

export type ParticipantRole = 'member' | 'admin' | 'superadmin';

export interface Participant {
  /** Canonical participant id used for group operations (LID or phone-number JID). */
  jid: string;
  /** Phone number, digits only, when WhatsApp reveals it. */
  phoneNumber?: string;
  /** LID JID when known. */
  lid?: string;
  /** Best-known display name (saved contact name or push name). */
  name?: string;
  role: ParticipantRole;
}

export interface GroupInfo {
  jid: string;
  name: string;
  participants: Participant[];
}

export interface SelfInfo {
  /** Digits only. */
  phoneNumber: string;
  /** e.g. 919876543210@s.whatsapp.net (device suffix stripped). */
  pnJid: string;
  /** e.g. 12345678901234@lid (device suffix stripped), when available. */
  lidJid?: string;
  name?: string;
}

export interface IncomingMessage {
  id: string;
  chatJid: string;
  /** Alternate addressing of the chat (PN ↔ LID) when WhatsApp provides it. */
  chatJidAlt?: string;
  fromMe: boolean;
  senderJid?: string;
  text: string;
  /** Milliseconds since epoch. */
  timestamp: number;
}

/** Per-participant result exactly as reported by WhatsApp. status '200' means success. */
export interface ParticipantUpdateResult {
  jid: string;
  status: string;
}

export type ConnectionStatus = 'connecting' | 'open' | 'closed' | 'logged_out';

export interface WhatsAppClient {
  getSelf(): SelfInfo | undefined;
  getConnectionStatus(): ConnectionStatus;
  /** Resolves true once connected, false on timeout. */
  waitForConnection(timeoutMs: number): Promise<boolean>;
  listGroups(): Promise<GroupInfo[]>;
  /** Throws GroupNotFoundError if the group does not exist or the account is not a member. */
  getGroup(jid: string): Promise<GroupInfo>;
  /** Removes participants. Throws on request-level failure; returns per-participant statuses otherwise. */
  removeParticipants(groupJid: string, participantJids: string[]): Promise<ParticipantUpdateResult[]>;
  /** Demotes admins to regular members. Per-participant statuses, like removeParticipants. */
  demoteParticipants(groupJid: string, participantJids: string[]): Promise<ParticipantUpdateResult[]>;
  /** Leaves the group. Resolves when WhatsApp accepted the request. */
  leaveGroup(groupJid: string): Promise<void>;
  /** True if the chat can be deleted for me (the latest message key of the chat is known). */
  canDeleteChat(groupJid: string): boolean;
  /**
   * Deletes the group chat for this account only (synced to your devices).
   * Waits up to `waitMs` for a message newer than `newerThanMs` (e.g. the "you left" notice) first.
   * Throws ChatDeleteUnavailableError if no message key is known.
   */
  deleteChatForMe(groupJid: string, opts?: { newerThanMs?: number; waitMs?: number }): Promise<void>;
  /** Sends a text message and returns the sent message id. */
  sendText(chatJid: string, text: string): Promise<string | undefined>;
}

export class ChatDeleteUnavailableError extends Error {
  constructor(jid: string) {
    super(`No known message for chat ${jid}; it cannot be deleted`);
    this.name = 'ChatDeleteUnavailableError';
  }
}

export class GroupNotFoundError extends Error {
  constructor(jid: string) {
    super(`Group not found or not accessible: ${jid}`);
    this.name = 'GroupNotFoundError';
  }
}

export class NotConnectedError extends Error {
  constructor() {
    super('WhatsApp is not connected');
    this.name = 'NotConnectedError';
  }
}
