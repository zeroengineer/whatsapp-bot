import { IndexSpecError, parseIndexSpec } from '../core/parser.js';
import { UserError, type BotState, type RemovalTarget } from '../core/types.js';
import { isAdmin, isSelfParticipant, normalizeJid } from '../utils/permissions.js';
import type { GroupInfo, Participant, SelfInfo } from '../whatsapp/client.js';

export interface MemberEntry {
  index: number;
  participant: Participant;
  label: string;
  isAdmin: boolean;
  isSelf: boolean;
}

export interface Selection {
  targets: RemovalTarget[];
  /** Selected entries that were excluded because they are admins or the account itself. */
  excluded: MemberEntry[];
  protectedAdmins: number;
  /** True when the index numbers came from a fresh list rather than the owner's last !members. */
  usedFreshList: boolean;
}

export function memberLabel(p: Participant): string {
  if (p.name && p.phoneNumber) return `${p.name} (+${p.phoneNumber})`;
  if (p.name) return p.name;
  if (p.phoneNumber) return `+${p.phoneNumber}`;
  return 'Hidden number';
}

const sortKey = (p: Participant) => p.name ?? (p.phoneNumber ? `+${p.phoneNumber}` : '￿');

/** True if two participant records refer to the same person (JID, LID or phone number). */
export function sameParticipant(a: Participant, b: Participant): boolean {
  if (normalizeJid(a.jid) === normalizeJid(b.jid)) return true;
  if (a.lid && b.lid && normalizeJid(a.lid) === normalizeJid(b.lid)) return true;
  return !!a.phoneNumber && a.phoneNumber === b.phoneNumber;
}

export class MemberService {
  constructor(private readonly state: BotState) {}

  /** Stable ordering: display name (case-insensitive), then JID. */
  buildList(group: GroupInfo, self: SelfInfo): MemberEntry[] {
    const sorted = [...group.participants].sort(
      (a, b) => sortKey(a).localeCompare(sortKey(b), undefined, { sensitivity: 'base' }) || a.jid.localeCompare(b.jid),
    );
    return sorted.map((participant, i) => ({
      index: i + 1,
      participant,
      label: memberLabel(participant),
      isAdmin: isAdmin(participant),
      isSelf: isSelfParticipant(participant, self),
    }));
  }

  rememberSnapshot(group: GroupInfo, list: MemberEntry[], now: number): void {
    this.state.memberSnapshots.set(group.jid, { jids: list.map((e) => e.participant.jid), takenAt: now });
  }

  formatList(group: GroupInfo, list: MemberEntry[]): string {
    const lines = list.map((e) => {
      const tags = [e.participant.role === 'superadmin' ? '[OWNER]' : e.isAdmin ? '[ADMIN]' : '', e.isSelf ? '[YOU]' : '']
        .filter(Boolean)
        .join(' ');
      return `${e.index}. ${e.label}${tags ? ` ${tags}` : ''}`;
    });
    const admins = list.filter((e) => e.isAdmin).length;
    return `${group.name}\n\n${lines.join('\n')}\n\nMembers: ${list.length} · Admins: ${admins}`;
  }

  /**
   * Map owner-supplied index numbers to participants.
   *
   * Numbers refer to the owner's most recent !members listing for this group. If a selected member
   * from that listing has since left, the whole selection is rejected so the owner re-checks the list.
   */
  select(group: GroupInfo, self: SelfInfo, indexSpec: string): Selection {
    let indexes: number[];
    try {
      indexes = parseIndexSpec(indexSpec);
    } catch (err) {
      if (err instanceof IndexSpecError) throw new UserError(`${err.message}\nExample: !remove ${group.name} 1,3,4`);
      throw err;
    }

    const fresh = this.buildList(group, self);
    const snapshot = this.state.memberSnapshots.get(group.jid);
    let numbered: MemberEntry[];
    let usedFreshList = false;

    if (snapshot) {
      numbered = [];
      const missing: number[] = [];
      snapshot.jids.forEach((jid, i) => {
        const entry = fresh.find((e) => normalizeJid(e.participant.jid) === normalizeJid(jid));
        if (entry) numbered.push({ ...entry, index: i + 1 });
        else if (indexes.includes(i + 1)) missing.push(i + 1);
      });
      if (missing.length > 0) {
        throw new UserError(
          `Member ${missing.join(', ')} from your last list is no longer in "${group.name}".\nSend !members again and re-check the numbers.`,
        );
      }
      const outOfRange = indexes.filter((n) => n > snapshot.jids.length);
      if (outOfRange.length > 0) {
        throw new UserError(`Invalid member number(s): ${outOfRange.join(', ')}. The list has ${snapshot.jids.length} members.`);
      }
    } else {
      numbered = fresh;
      usedFreshList = true;
      const outOfRange = indexes.filter((n) => n > fresh.length);
      if (outOfRange.length > 0) {
        throw new UserError(`Invalid member number(s): ${outOfRange.join(', ')}. "${group.name}" has ${fresh.length} members.`);
      }
    }

    const chosen = indexes.map((n) => numbered.find((e) => e.index === n)).filter((e): e is MemberEntry => !!e);
    const excluded = chosen.filter((e) => e.isAdmin || e.isSelf);
    const targets = chosen
      .filter((e) => !e.isAdmin && !e.isSelf)
      .map((e) => ({ index: e.index, participant: e.participant, label: e.label }));

    return { targets, excluded, protectedAdmins: fresh.filter((e) => e.isAdmin).length, usedFreshList };
  }

  /** Every member who is neither an admin nor the account itself. */
  selectAllNonAdmins(group: GroupInfo, self: SelfInfo): Selection {
    const list = this.buildList(group, self);
    return {
      targets: list.filter((e) => !e.isAdmin && !e.isSelf).map((e) => ({ index: e.index, participant: e.participant, label: e.label })),
      excluded: [],
      protectedAdmins: list.filter((e) => e.isAdmin).length,
      usedFreshList: true,
    };
  }
}
