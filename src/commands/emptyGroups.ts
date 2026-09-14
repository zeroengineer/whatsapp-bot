import type { Command } from '../core/types.js';
import { isAdmin, isSelfParticipant } from '../utils/permissions.js';

const CANT_DELETE = " [chat can't be deleted]";

export const emptyGroupsCommand: Command = {
  name: 'emptygroups',
  usage: 'emptygroups',
  description: 'List admin groups with no regular members left',
  async execute({ services, wa, config, now }) {
    const self = services.groups.requireSelf();
    const found = await services.groups.listByCategory('leftover', now());
    if (found.length === 0) return 'None of your admin groups is empty: every one still has regular members.';

    const lines = found.map(({ index, group }) => {
      const others = group.participants.filter((p) => !isSelfParticipant(p, self) && isAdmin(p));
      const creator = others.some((p) => p.role === 'superadmin');
      const who =
        others.length === 0
          ? 'only you'
          : `you + ${others.length} admin${others.length === 1 ? '' : 's'}${creator ? " (creator can't be removed)" : ''}`;
      return `${index}. ${group.name} — ${who}${wa.canDeleteChat(group.jid) ? '' : CANT_DELETE}`;
    });
    const p = config.commandPrefix;
    const example = found
      .filter((f) => wa.canDeleteChat(f.group.jid))
      .slice(0, 2)
      .map((f) => f.index)
      .join(',');
    return [
      'Groups With No Regular Members',
      '',
      ...lines,
      '',
      `Use ${p}leave ${example || '<numbers>'} or ${p}leave all to remove the other admins, leave and delete these chats.`,
      found.some((f) => !wa.canDeleteChat(f.group.jid)) ? `Groups marked${CANT_DELETE} will be skipped.` : '',
    ]
      .join('\n')
      .trimEnd();
  },
};
