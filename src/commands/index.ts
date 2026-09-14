import type { Command } from '../core/types.js';
import { adminGroupsCommand } from './adminGroups.js';
import { cancelCommand } from './cancel.js';
import { emptyGroupsCommand } from './emptyGroups.js';
import { groupsCommand } from './groups.js';
import { helpCommand } from './help.js';
import { leaveCommand } from './leave.js';
import { membersCommand } from './members.js';
import { nonAdminGroupsCommand } from './nonAdminGroups.js';
import { removeCommand } from './remove.js';
import { removeAllCommand } from './removeAll.js';
import { statusCommand } from './status.js';

export { handleConfirm } from './confirm.js';

export function createCommandRegistry(): Map<string, Command> {
  const commands = [
    helpCommand,
    groupsCommand,
    adminGroupsCommand,
    emptyGroupsCommand,
    nonAdminGroupsCommand,
    membersCommand,
    removeCommand,
    removeAllCommand,
    leaveCommand,
    cancelCommand,
    statusCommand,
  ];
  return new Map(commands.map((c) => [c.name, c]));
}
