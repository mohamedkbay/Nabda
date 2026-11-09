import assert from "node:assert/strict";
import { invocationSchema, grantsSchema, sessionOptionsSchema, driverMessageSchema } from "../scripts/connector-preview/protocol.mjs";

// Exercise the actual connector protocol after the Zod 4 migration. No tools,
// account credentials, network requests or provider calls are involved.
const fields = { connectorId: "fixture", actionName: "read" };
const args = { query: "fixture", nested: { enabled: true }, values: [null, 1] };
assert.deepEqual(invocationSchema.parse({ ...fields, arguments: args }).arguments, args);
assert.deepEqual(invocationSchema.parse({ ...fields, arguments: {} }).arguments, {});
for (const argumentsValue of [null, [], "invalid"]) {
  assert.equal(invocationSchema.safeParse({ ...fields, arguments: argumentsValue }).success, false);
}
assert.equal(invocationSchema.safeParse({ ...fields, arguments: {}, accountId: "not-allowed" }).success, false);
assert.equal(grantsSchema.safeParse([{ ...fields, readOnly: false }]).success, false);
assert.deepEqual(grantsSchema.parse([{ ...fields, readOnly: true }]), [{ ...fields, readOnly: true }]);
assert.deepEqual(sessionOptionsSchema.parse({}), { timeoutMs: 120000, maxConcurrent: 64 });
for (const options of [{ timeoutMs: 2 ** 31 }, { maxConcurrent: 0 }, { maxCalls: 1.5 }]) {
  assert.equal(sessionOptionsSchema.safeParse(options).success, false);
}
const result = { content: [{ type: "text", text: "fixture" }], structuredContent: { count: 1 } };
assert.deepEqual(driverMessageSchema.parse({ jsonrpc: "2.0", id: "123e4567-e89b-42d3-a456-426614174000", result }).result, result);
assert.deepEqual(driverMessageSchema.parse({ jsonrpc: "2.0", method: "stop" }), { jsonrpc: "2.0", method: "stop" });
assert.equal(driverMessageSchema.safeParse({ jsonrpc: "2.0", id: "not-a-uuid", result }).success, false);
console.log("PASS connector protocol: Zod 4 records, scope restrictions, limits and driver envelopes.");
