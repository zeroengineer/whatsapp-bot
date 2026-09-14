import type { Command } from '../core/types.js';
import { selfIsGroupAdmin } from '../utils/permissions.js';

export const groupsCommand: Command = {
  name: 'groups',
  usage: 'groups',
  description: 'List your WhatsApp groups',
  async execute({ services, config }) {
    const self = services.groups.requireSelf();
    const groups = await services.groups.listGroups();
    if (groups.length === 0) return 'Your account is not in any groups.';

    const lines = groups.map((g, i) => `${i + 1}. ${g.name}${selfIsGroupAdmin(g, self) ? ' [ADMIN]' : ''}`);
    const adminCount = groups.filter((g) => selfIsGroupAdmin(g, self)).length;
    return [
      'Your WhatsApp Groups',
      '',
      ...lines,
      '',
      `You are an admin in ${adminCount} of ${groups.length} groups.`,
      `Use ${config.commandPrefix}members <number> to see members.`,
    ].join('\n');
  },
};
