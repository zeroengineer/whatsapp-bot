import type { Command } from '../core/types.js';

export const adminGroupsCommand: Command = {
  name: 'admingroups',
  usage: 'admingroups',
  description: 'List only the groups where you are an admin',
  async execute({ services, config, state }) {
    const admin = await services.groups.listAdminGroups();
    const total = state.groupList?.length ?? 0;
    if (admin.length === 0) return `You are not an admin in any of your ${total} groups.`;

    const p = config.commandPrefix;
    const example = admin
      .slice(0, 2)
      .map((a) => a.index)
      .join(',');
    return [
      'Groups You Admin',
      '',
      ...admin.map(({ index, group }) => `${index}. ${group.name}`),
      '',
      `You are an admin in ${admin.length} of ${total} groups.`,
      'Numbers match !groups.',
      admin.length > 1 ? `Use ${p}removeall ${example} to clear several groups at once.` : `Use ${p}members ${example} to see members.`,
    ].join('\n');
  },
};
