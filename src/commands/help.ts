import type { Command } from '../core/types.js';

export const helpCommand: Command = {
  name: 'help',
  usage: 'help',
  description: 'Show this help',
  async execute({ config }) {
    const p = config.commandPrefix;
    return [
      'WhatsApp Group Bot — commands',
      '',
      `${p}help — show this help`,
      `${p}groups — list your groups`,
      `${p}admingroups — list only groups where you are admin`,
      `${p}members <group> — list members (admins marked)`,
      `${p}remove <group> <numbers> — preview removing members`,
      `   e.g. ${p}remove College Group 1,3,4  or  ${p}remove 2 1-5`,
      `${p}removeall <group> — preview removing all non-admins`,
      `${p}removeall 1,3,7 — same, for several groups at once`,
      `   or ${p}removeall College Group | Project Team`,
      `${p}cancel — cancel the pending operation`,
      `${p}status — bot status`,
      '',
      `<group> is the number from ${p}groups or the group name (use "quotes" if the name ends in a number).`,
      `Member numbers come from ${p}members.`,
      `Add --dry-run to ${p}remove / ${p}removeall to simulate without removing anyone.`,
      '',
      'Removals always need confirmation: reply CONFIRM (or CONFIRM REMOVEALL).',
      'Administrators and your own account are never removed.',
      config.dryRun ? '\nDRY-RUN MODE IS ON: nobody will actually be removed.' : '',
    ]
      .join('\n')
      .trimEnd();
  },
};
