import { unquote } from '../core/parser.js';
import { UserError, type Command } from '../core/types.js';

export const membersCommand: Command = {
  name: 'members',
  usage: 'members <group>',
  description: 'List members of a group',
  async execute({ command, services, config, now }) {
    if (!command.args) throw new UserError(`Usage: ${config.commandPrefix}members <group>`);
    const self = services.groups.requireSelf();
    // Admin rights are required: member numbers from this list are used for removals.
    const group = await services.groups.resolveAdminGroup(unquote(command.args));
    const list = services.members.buildList(group, self);
    services.members.rememberSnapshot(group, list, now());
    return services.members.formatList(group, list);
  },
};
