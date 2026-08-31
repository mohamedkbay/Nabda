import { DelayedError, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { loadConfig } from "./config.js";
import { createPostgresPool } from "./db/pool.js";
import { SecretBox } from "./lib/crypto.js";
import { MessageRetentionCleaner } from "./maintenance/message-retention-cleaner.js";
import { createProviderRegistry } from "./providers/provider-factory.js";
import { OutboxDispatcher } from "./queue/outbox-dispatcher.js";
import { createQueuePublisher, MESSAGE_QUEUE, WEBHOOK_QUEUE } from "./queue/queues.js";
import { PostgresRepository } from "./repositories/postgres-repository.js";
import { MessageProcessor } from "./worker/message-processor.js";
import { StatusReconciler } from "./worker/status-reconciler.js";
import { WebhookProcessor } from "./worker/webhook-processor.js";

const config = loadConfig();
const pool = createPostgresPool(config.DATABASE_URL, config.DB_POOL_MAX);
const executionMode = config.PROVIDER_MODE === "httpsms" || config.ENABLE_ANDROID_AGENT_LIVE_REPORTING
  ? "live"
  : "simulation";
const repository = new PostgresRepository(pool, config.PROVIDER_MODE, config.ENABLE_ANDROID_AGENT, executionMode);
const retentionCleaner = new MessageRetentionCleaner(
  pool,
  config.CLEANUP_INTERVAL_MS,
  config.CLEANUP_BATCH_SIZE,
);
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true });
connection.on("error", (error) => process.stderr.write(`Redis worker connection error: ${error.message}\n`));
const publisher = createQueuePublisher(connection, config.QUEUE_PREFIX);
const dispatcher = new OutboxDispatcher(repository, publisher);
const secretBox = new SecretBox(config.APP_ENCRYPTION_KEY);
const providerRegistry = createProviderRegistry(config);
const messageProcessor = new MessageProcessor(
  repository,
  providerRegistry,
  secretBox,
  config.DISPATCH_MIN_INTERVAL_MS,
);
const statusReconciler = new StatusReconciler(
  repository,
  providerRegistry,
  secretBox,
  config.STATUS_POLL_INTERVAL_MS,
);
const webhookProcessor = new WebhookProcessor(
  repository,
  secretBox,
  config.NODE_ENV,
  config.WEBHOOK_TIMEOUT_MS,
);
// Dispatch safety checks and fences use short database transactions; provider I/O
// starts only after those transactions release their connections.
const messageWorkerConcurrency = Math.max(1, Math.min(10, Math.floor((config.DB_POOL_MAX - 4) / 2)));

const messageWorker = new Worker(
  MESSAGE_QUEUE,
  async (job: Job<{ messageId?: unknown }>) => {
    if (typeof job.data.messageId !== "string") throw new Error("Invalid message job payload.");
    const result = await messageProcessor.process(job.data.messageId);
    if (result.kind === "rate_limited") {
      await job.moveToDelayed(result.retryAt.getTime(), job.token);
      throw new DelayedError();
    }
  },
  {
    connection,
    prefix: config.QUEUE_PREFIX,
    concurrency: messageWorkerConcurrency,
  },
);
const webhookWorker = new Worker(
  WEBHOOK_QUEUE,
  async (job: Job<{ deliveryId?: unknown }>) => {
    if (typeof job.data.deliveryId !== "string") throw new Error("Invalid webhook job payload.");
    await webhookProcessor.process(job.data.deliveryId);
  },
  { connection, prefix: config.QUEUE_PREFIX, concurrency: 10 },
);

for (const worker of [messageWorker, webhookWorker]) {
  worker.on("failed", (job, error) => {
    process.stderr.write(`Worker job ${job?.id ?? "unknown"} failed: ${error.message}\n`);
  });
}
dispatcher.start();
statusReconciler.start();
retentionCleaner.start();
process.stdout.write(`Nabda worker started in ${config.PROVIDER_MODE} provider mode.\n`);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await dispatcher.close();
  await Promise.all([statusReconciler.close(), retentionCleaner.close()]);
  await Promise.all([messageWorker.close(), webhookWorker.close()]);
  await publisher.close();
  connection.disconnect();
  await pool.end();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
