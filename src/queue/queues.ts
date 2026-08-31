import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { OutboxJob } from "../domain/types.js";

export const MESSAGE_QUEUE = "message-dispatch";
export const WEBHOOK_QUEUE = "webhook-delivery";
export const WEBHOOK_JOB_OPTIONS = {
  attempts: 8,
  backoff: { type: "exponential" as const, delay: 60_000 },
  // PostgreSQL is the durable delivery ledger. Removing terminal Bull records
  // lets a repaired lease/outbox republish the same delivery ID after a crash.
  removeOnComplete: true,
  removeOnFail: true,
} as const;

export interface QueuePublisher {
  publish(job: OutboxJob): Promise<void>;
  close(): Promise<void>;
}

export function createQueuePublisher(connection: Redis, prefix: string): QueuePublisher {
  const messageQueue = new Queue(MESSAGE_QUEUE, { connection, prefix });
  const webhookQueue = new Queue(WEBHOOK_QUEUE, { connection, prefix });
  return {
    async publish(job) {
      if (job.kind === "message.dispatch") {
        await messageQueue.add("dispatch", { messageId: job.aggregateId }, {
          jobId: `message-${job.aggregateId}`,
          attempts: 1,
          removeOnComplete: { age: 24 * 60 * 60, count: 10_000 },
          // The durable outbox must be able to republish a failed pre-dispatch job with this ID.
          removeOnFail: true,
        });
        return;
      }
      await webhookQueue.add("deliver", { deliveryId: job.aggregateId }, {
        jobId: `webhook-${job.aggregateId}`,
        ...WEBHOOK_JOB_OPTIONS,
      });
    },
    async close() {
      await Promise.all([messageQueue.close(), webhookQueue.close()]);
    },
  };
}
