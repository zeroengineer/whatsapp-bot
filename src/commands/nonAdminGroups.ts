import type { Command } from '../core/types.js';

const CANT_DELETE = " [chat can't be deleted]";

export const nonAdminGroupsCommand: Command = {
  name: 'nonadmingroups',
  usage: 'nonadmingroups',
  description: 'List groups where you are not an admin',
  async execute({ services, wa, config, now }) {
    const found = await services.groups.listByCategory('nonadmin', now());
    if (found.length === 0) return 'You are an admin in all of your groups.';

    const p = config.commandPrefix;
    return [
      'Groups Where You Are Not Admin',
      '',
      ...found.map(({ index, group }) => `${index}. ${group.name} — ${group.participants.length} members${wa.canDeleteChat(group.jid) ? '' : CANT_DELETE}`),
      '',
      `Use ${p}leave <numbers> or ${p}leave all to leave and delete these chats.`,
      found.some((f) => !wa.canDeleteChat(f.group.jid)) ? `Groups marked${CANT_DELETE} will be skipped.` : '',
    ]
      .join('\n')
      .trimEnd();
  },
};
