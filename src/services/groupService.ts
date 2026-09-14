import { parseIndexSpec, splitGroupAndIndexes, type GroupAndIndexSplit } from '../core/parser.js';
import { UserError, type BotState } from '../core/types.js';
import { isAdmin, isSelfParticipant, selfIsGroupAdmin } from '../utils/permissions.js';
import { GroupNotFoundError, type GroupInfo, type SelfInfo, type WhatsAppClient } from '../whatsapp/client.js';

export const MAX_GROUPS_PER_OPERATION = 20;
export const LEAVE_LIST_TTL_MS = 10 * 60_000;

export type GroupCategory = 'leftover' | 'nonadmin' | 'active';

const normalizeName = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

const compareGroups = (a: { name: string; jid: string }, b: { name: string; jid: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.jid.localeCompare(b.jid);

export type GroupMatch =
  | { kind: 'found'; group: { jid: string; name: string }; via: 'index' | 'exact' | 'partial' }
  | { kind: 'ambiguous'; matches: { jid: string; name: string }[] }
  | { kind: 'not_found' };

export class GroupService {
  constructor(
    private readonly wa: WhatsAppClient,
    private readonly state: BotState,
  ) {}

  requireSelf(): SelfInfo {
    const self = this.wa.getSelf();
    if (!self || this.wa.getConnectionStatus() !== 'open') throw new UserError('WhatsApp is not connected right now. Try again shortly.');
    return self;
  }

  /** Fetch all groups, sorted by name, and remember the numbering for index-based lookups. */
  async listGroups(): Promise<GroupInfo[]> {
    const groups = (await this.wa.listGroups()).sort(compareGroups);
    this.state.groupList = groups.map((g) => ({ jid: g.jid, name: g.name }));
    return groups;
  }

  /** Match a query against a group list: list number, exact name, or unique partial name. */
  static match(query: string, list: { jid: string; name: string }[]): GroupMatch {
    const q = query.trim();
    if (!q) return { kind: 'not_found' };

    if (/^\d+$/.test(q)) {
      const entry = list[Number(q) - 1];
      if (entry) return { kind: 'found', group: entry, via: 'index' };
    }

    const nq = normalizeName(q);
    const exact = list.filter((g) => normalizeName(g.name) === nq);
    if (exact.length === 1 && exact[0]) return { kind: 'found', group: exact[0], via: 'exact' };
    if (exact.length > 1) return { kind: 'ambiguous', matches: exact };

    const partial = list.filter((g) => normalizeName(g.name).includes(nq));
    if (partial.length === 1 && partial[0]) return { kind: 'found', group: partial[0], via: 'partial' };
    if (partial.length > 1) return { kind: 'ambiguous', matches: partial };
    return { kind: 'not_found' };
  }

  private async currentList(): Promise<{ jid: string; name: string }[]> {
    return this.state.groupList ?? (await this.listGroups());
  }

  private static ambiguousError(matches: { name: string }[]): UserError {
    const shown = matches.slice(0, 10).map((m) => `- ${m.name}`).join('\n');
    return new UserError(`More than one group matches:\n${shown}\n\nUse the group number from !groups or the full name.`);
  }

  /** Resolve a group query and fetch fresh metadata. */
  async resolve(query: string): Promise<GroupInfo> {
    let match = GroupService.match(query, await this.currentList());
    // The cached list may be outdated (new group, renamed group): retry once with a fresh list.
    if (match.kind === 'not_found' && this.state.groupList) {
      match = GroupService.match(query, await this.listGroups());
    }
    if (match.kind === 'ambiguous') throw GroupService.ambiguousError(match.matches);
    if (match.kind === 'not_found') throw new UserError(`Group "${query}" not found. Send !groups to see your groups.`);
    return this.wa.getGroup(match.group.jid);
  }

  /** Resolve a group and require that the authenticated account is an admin there. */
  async resolveAdminGroup(query: string): Promise<GroupInfo> {
    const self = this.requireSelf();
    const group = await this.resolve(query);
    if (!selfIsGroupAdmin(group, self)) {
      throw new UserError(`You are not an administrator of "${group.name}". The bot only manages groups where you are an admin.`);
    }
    return group;
  }

  /** Admin groups only, each keeping its 1-based number from the full (!groups) list. */
  async listAdminGroups(): Promise<{ index: number; group: GroupInfo }[]> {
    const self = this.requireSelf();
    const all = await this.listGroups();
    return all.map((group, i) => ({ index: i + 1, group })).filter(({ group }) => selfIsGroupAdmin(group, self));
  }

  /**
   * leftover: you are admin and every other member is an admin (or you are alone);
   * nonadmin: you are a member but not an admin;
   * active: you are admin and regular members remain.
   */
  static classify(group: GroupInfo, self: SelfInfo): GroupCategory {
    if (!selfIsGroupAdmin(group, self)) return 'nonadmin';
    const regular = group.participants.some((p) => !isSelfParticipant(p, self) && !isAdmin(p));
    return regular ? 'active' : 'leftover';
  }

  /** Groups of one category, keeping !groups numbering. Remembers the list for `!leave all`. */
  async listByCategory(category: 'leftover' | 'nonadmin', now: number): Promise<{ index: number; group: GroupInfo }[]> {
    const self = this.requireSelf();
    const all = await this.listGroups();
    const found = all.map((group, i) => ({ index: i + 1, group })).filter(({ group }) => GroupService.classify(group, self) === category);
    this.state.lastLeaveList = { category, jids: found.map((f) => f.group.jid), at: now };
    return found;
  }

  /**
   * Resolve `!leave` arguments ("all" or group numbers) to fresh group metadata.
   * Rejects the whole selection if a number is invalid, an admin group still has regular members,
   * or too many groups are selected.
   */
  async resolveLeaveSelection(args: string, now: number): Promise<{ groups: { index: number; group: GroupInfo }[] }> {
    const self = this.requireSelf();
    const arg = args.trim().toLowerCase();
    let jids: string[];

    if (arg === 'all') {
      const last = this.state.lastLeaveList;
      if (!last || now - last.at > LEAVE_LIST_TTL_MS) {
        throw new UserError('Send !emptygroups or !nonadmingroups first, then !leave all within 10 minutes.');
      }
      if (last.jids.length === 0) throw new UserError('Your last list was empty. Nothing to leave.');
      jids = last.jids;
    } else {
      let indexes: number[];
      try {
        indexes = parseIndexSpec(arg);
      } catch {
        throw new UserError('Usage: !leave <group numbers>  (e.g. !leave 2,5)  or  !leave all');
      }
      const list = await this.currentList();
      const missing = indexes.filter((n) => !list[n - 1]);
      if (missing.length > 0) throw new UserError(`Group number(s) ${missing.join(', ')} do not exist (you have ${list.length} groups).`);
      jids = indexes.map((n) => list[n - 1]!.jid);
    }

    const unique = [...new Set(jids)];
    if (unique.length > MAX_GROUPS_PER_OPERATION) {
      throw new UserError(`Too many groups selected (${unique.length}). The limit is ${MAX_GROUPS_PER_OPERATION} per operation.`);
    }

    const list = await this.currentList();
    const groups: { index: number; group: GroupInfo }[] = [];
    const active: string[] = [];
    const gone: string[] = [];
    for (const jid of unique) {
      const index = list.findIndex((g) => g.jid === jid) + 1;
      let group: GroupInfo;
      try {
        group = await this.wa.getGroup(jid);
      } catch (err) {
        if (err instanceof GroupNotFoundError) {
          gone.push(list[index - 1]?.name ?? jid);
          continue;
        }
        throw err;
      }
      if (GroupService.classify(group, self) === 'active') active.push(group.name);
      else groups.push({ index, group });
    }

    const problems: string[] = [];
    if (active.length > 0) {
      problems.push(`These groups still have regular members — use !removeall first:\n${active.map((n) => `- ${n}`).join('\n')}`);
    }
    if (gone.length > 0) problems.push(`No longer accessible (already left?):\n${gone.map((n) => `- ${n}`).join('\n')}`);
    if (problems.length > 0) throw new UserError(`${problems.join('\n\n')}\n\nNothing was queued.`);
    return { groups };
  }

  /**
   * Resolve several groups (by !groups numbers or by names) and require admin rights in all of them.
   * Any problem rejects the whole selection with one message listing every issue.
   */
  async resolveAdminGroups(
    selection: { kind: 'numbers'; indexes: number[] } | { kind: 'names'; names: string[] },
  ): Promise<{ groups: GroupInfo[]; usedFreshList: boolean }> {
    const self = this.requireSelf();
    const usedFreshList = !this.state.groupList;
    const problems: string[] = [];
    const chosen = new Map<string, { jid: string; name: string }>();

    if (selection.kind === 'numbers') {
      const list = await this.currentList();
      for (const n of selection.indexes) {
        const entry = list[n - 1];
        if (entry) chosen.set(entry.jid, entry);
        else problems.push(`Group number ${n} does not exist (you have ${list.length} groups).`);
      }
    } else {
      for (const name of selection.names) {
        let match = GroupService.match(name, await this.currentList());
        if (match.kind === 'not_found' && this.state.groupList) match = GroupService.match(name, await this.listGroups());
        if (match.kind === 'found') chosen.set(match.group.jid, match.group);
        else if (match.kind === 'ambiguous') problems.push(`"${name}" matches several groups: ${match.matches.slice(0, 5).map((m) => m.name).join(', ')}.`);
        else problems.push(`Group "${name}" not found.`);
      }
    }

    if (chosen.size > MAX_GROUPS_PER_OPERATION) {
      problems.push(`Too many groups selected (${chosen.size}). The limit is ${MAX_GROUPS_PER_OPERATION} per operation.`);
    }
    if (problems.length > 0) throw new UserError(`${problems.join('\n')}\n\nNothing was queued. Send !admingroups to see your groups.`);

    const groups: GroupInfo[] = [];
    const notAdmin: string[] = [];
    for (const entry of chosen.values()) {
      const group = await this.wa.getGroup(entry.jid);
      if (selfIsGroupAdmin(group, self)) groups.push(group);
      else notAdmin.push(group.name);
    }
    if (notAdmin.length > 0) {
      throw new UserError(
        `You are not an administrator of:\n${notAdmin.map((n) => `- ${n}`).join('\n')}\n\nRemove them from the selection. Nothing was queued.`,
      );
    }
    return { groups, usedFreshList };
  }

  /**
   * Resolve "<group> <indexes>" where the group name may end in digits.
   * Picks the split whose group part matches (index/exact beats partial); errors if splits disagree.
   */
  async resolveWithIndexes(args: string): Promise<{ group: GroupInfo; indexSpec: string }> {
    const splits = splitGroupAndIndexes(args);
    if (splits.length === 0) throw new UserError('Please give a group and member numbers.');

    const pick = (list: { jid: string; name: string }[]) => {
      const found: { split: GroupAndIndexSplit; match: Extract<GroupMatch, { kind: 'found' }> }[] = [];
      let ambiguous: { name: string }[] | undefined;
      for (const split of splits) {
        const m = GroupService.match(split.groupQuery, list);
        if (m.kind === 'found') found.push({ split, match: m });
        else if (m.kind === 'ambiguous' && !ambiguous) ambiguous = m.matches;
      }
      const strong = found.filter((f) => f.match.via !== 'partial');
      const candidates = strong.length > 0 ? strong : found;
      const distinct = new Set(candidates.map((c) => c.match.group.jid));
      if (distinct.size > 1) {
        throw new UserError(
          'That command could refer to more than one group. Put the group name in quotes, e.g.\n!remove "Batch 2024" 1,3\nor use the group number from !groups.',
        );
      }
      return { chosen: candidates[0], ambiguous };
    };

    let { chosen, ambiguous } = pick(await this.currentList());
    if (!chosen && this.state.groupList) ({ chosen, ambiguous } = pick(await this.listGroups()));
    if (!chosen) {
      if (ambiguous) throw GroupService.ambiguousError(ambiguous);
      throw new UserError('Group not found. Send !groups to see your groups.');
    }

    const self = this.requireSelf();
    const group = await this.wa.getGroup(chosen.match.group.jid);
    if (!selfIsGroupAdmin(group, self)) {
      throw new UserError(`You are not an administrator of "${group.name}". The bot only manages groups where you are an admin.`);
    }
    return { group, indexSpec: chosen.split.indexSpec };
  }
}
