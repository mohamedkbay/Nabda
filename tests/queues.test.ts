import { describe, expect, it } from "vitest";
import { WEBHOOK_JOB_OPTIONS } from "../src/queue/queues.js";

describe("durable webhook queue policy", () => {
  it("removes terminal BullMQ records so PostgreSQL lease recovery can republish the same ID", () => {
    expect(WEBHOOK_JOB_OPTIONS).toMatchObject({
      attempts: 8,
      removeOnComplete: true,
      removeOnFail: true,
    });
  });
});
