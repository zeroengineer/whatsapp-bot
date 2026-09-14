import path from 'node:path';
import { ConfigError, loadConfig, type AppConfig } from './config.js';
import { CommandRouter } from './core/router.js';
import type { BotState, Services } from './core/types.js';
import { ConfirmationService } from './services/confirmationService.js';
import { GroupService } from './services/groupService.js';
import { LeaveService } from './services/leaveService.js';
import { MemberService } from './services/memberService.js';
import { RemovalService } from './services/removalService.js';
import { createLogger, type Logger } from './utils/logger.js';
import { ownerMatchesAccount } from './utils/permissions.js';
import { WhatsAppConnection } from './whatsapp/connection.js';
import { BaileysWhatsAppClient } from './whatsapp/groups.js';
import { LastMessageIndex } from './whatsapp/messageIndex.js';

const SHUTDOWN_WAIT_MS = 30_000;

async function main(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger({ level: config.logLevel, logDir: config.logDir, pretty: process.stdout.isTTY });
  logger.info({ dryRun: config.dryRun, authMethod: config.authMethod, prefix: config.commandPrefix }, 'Starting WhatsApp group bot');
  if (config.dryRun) logger.warn('DRY-RUN MODE: no members will be removed');

  const messageIndex = new LastMessageIndex(path.join(config.dataDir, 'last-messages.json'), logger);
  messageIndex.load();
  const connection = new WhatsAppConnection(config, logger, messageIndex);
  const wa = new BaileysWhatsAppClient(connection, logger, config.operationTimeoutMs, messageIndex);
  const state: BotState = { startedAt: Date.now(), memberSnapshots: new Map() };
  const removal = new RemovalService(wa, logger, { batchSize: config.removeBatchSize, batchDelayMs: config.removeBatchDelayMs });
  const services: Services = {
    groups: new GroupService(wa, state),
    members: new MemberService(state),
    confirmations: new ConfirmationService(config.confirmTtlMs),
    removal,
    leave: new LeaveService(wa, removal, logger, { batchDelayMs: config.removeBatchDelayMs }),
  };
  const router = new CommandRouter({ wa, config, logger, state, services });

  let shuttingDown = false;
  const shutdown = async (reason: string, exitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason }, 'Shutting down');
    router.stopAccepting();
    services.confirmations.cancel();
    if (services.removal.getRunning()) {
      logger.warn('Waiting for the running operation to stop at its next safe point');
      services.removal.requestCancel();
      const idle = await services.removal.waitForIdle(SHUTDOWN_WAIT_MS);
      if (!idle) logger.error('Operation did not finish in time; exiting anyway (check the group for its final state)');
    }
    messageIndex.flush();
    await connection.stop().catch(() => undefined);
    await flushLogger(logger);
    process.exit(exitCode);
  };

  connection.on('message', (msg) => {
    router.handle(msg).catch((err: unknown) => logger.error({ err: String(err) }, 'Unhandled error in message handler'));
  });

  connection.on('status', (status) => {
    if (status !== 'open') return;
    const self = connection.getSelf();
    if (self && !ownerMatchesAccount(config.ownerPhone, self)) {
      logger.fatal(
        { linkedAccount: self.phoneNumber },
        'OWNER_PHONE does not match the linked WhatsApp account. Refusing to run. Fix OWNER_PHONE or re-link the correct account.',
      );
      void shutdown('owner mismatch', 1);
    }
  });

  connection.on('fatal', (reason) => void shutdown(reason, 1));

  process.on('SIGINT', () => void shutdown('SIGINT', 0));
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.on('unhandledRejection', (reason) => logger.error({ reason: String(reason) }, 'Unhandled promise rejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: { name: err.name, message: err.message, stack: err.stack } }, 'Uncaught exception');
    void shutdown('uncaughtException', 1);
  });

  await connection.start();
}

function flushLogger(logger: Logger): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    logger.flush(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

main().catch((err: unknown) => {
  console.error('Fatal startup error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
