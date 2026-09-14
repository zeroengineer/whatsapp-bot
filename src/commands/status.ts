import { describeOperation, type Command } from '../core/types.js';
import { withTimeout } from '../utils/retry.js';

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [d ? `${d}d` : '', h ? `${h}h` : '', m ? `${m}m` : '', `${s % 60}s`].filter(Boolean);
  return parts.join(' ');
}

export const statusCommand: Command = {
  name: 'status',
  usage: 'status',
  description: 'Show bot status',
  async execute({ wa, state, services, config, now }) {
    const connection = wa.getConnectionStatus();
    const self = wa.getSelf();

    let groupCount = 'unknown';
    if (connection === 'open') {
      try {
        const groups = await withTimeout(wa.listGroups(), 15_000, 'status group count');
        groupCount = String(groups.length);
      } catch {
        groupCount = state.groupList ? `${state.groupList.length} (cached)` : 'unavailable';
      }
    }

    const pending = services.confirmations.getPending();
    const running = services.removal.getRunning();
    const last = state.lastCommand;
    const lastName = last?.name.startsWith('confirm') ? last.name.replace('_', ' ').toUpperCase() : `${config.commandPrefix}${last?.name}`;

    return [
      'Bot Status',
      '',
      `WhatsApp: ${connection}`,
      `Uptime: ${formatDuration(now() - state.startedAt)}`,
      `Account: ${self ? `+${self.phoneNumber}` : 'not linked'}`,
      `Groups: ${groupCount}`,
      `Last command: ${last ? `${lastName} (${formatDuration(now() - last.at)} ago)` : 'none'}`,
      `Pending operation: ${pending ? `${describeOperation(pending)}, expires in ${Math.max(0, Math.round((pending.expiresAt - now()) / 1000))}s` : 'none'}`,
      `Running operation: ${running ? `removing in "${running.groupName}" (${running.groupCount > 1 ? `group ${running.groupIndex + 1}/${running.groupCount}, ` : ''}${running.processed}/${running.total})` : 'none'}`,
      `Dry-run mode: ${config.dryRun ? 'ON' : 'off'}`,
    ].join('\n');
  },
};
