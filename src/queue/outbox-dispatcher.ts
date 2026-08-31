import { randomUUID } from "node:crypto";
import type { Repository } from "../repositories/repository.js";
import type { QueuePublisher } from "./queues.js";

export class OutboxDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly lockId = randomUUID();

  constructor(
    private readonly repository: Repository,
    private readonly publisher: QueuePublisher,
    private readonly pollIntervalMs = 500,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.trigger(), this.pollIntervalMs);
    this.timer.unref();
    this.trigger();
  }

  private trigger(): void {
    void this.runOnce().catch(() => {
      process.stderr.write("Outbox dispatcher cycle failed; it will retry.\n");
    });
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      const jobs = await this.repository.claimOutboxJobs(50, this.lockId, now);
      for (const job of jobs) {
        try {
          await this.publisher.publish(job);
          await this.repository.markOutboxPublished(job.id, this.lockId, new Date());
        } catch (error) {
          const delay = Math.min(60_000, 1000 * 2 ** Math.min(job.attempts, 6));
          const message = error instanceof Error ? error.message : "Queue publish failed.";
          await this.repository.releaseOutboxJob(job.id, this.lockId, new Date(Date.now() + delay), message);
        }
      }
    } finally {
      this.running = false;
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
