import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { generateApiKey } from "../lib/crypto.js";
import { createPostgresPool } from "./pool.js";

function requiredSeedValue(name: string, fallback: string): string {
  const value = String(process.env[name] || fallback).trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export async function seed(): Promise<void> {
  const config = loadConfig();
  if (config.NODE_ENV === "production") throw new Error("The development seed is disabled in production.");
  const pool = createPostgresPool(config.DATABASE_URL, config.DB_POOL_MAX);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const plan = await client.query<{ id: string }>(`
      INSERT INTO plans (
        code, name, description, monthly_message_limit, per_minute_message_limit,
        max_devices, max_api_keys, max_webhooks, retention_days, monthly_price_minor, currency
      ) VALUES ('free', 'Free', 'Permanent free platform plan with explicit limits', 1000, 10, 1, 3, 2, 30, 0, 'LYD')
      ON CONFLICT (code) DO UPDATE SET
        monthly_message_limit = EXCLUDED.monthly_message_limit,
        per_minute_message_limit = EXCLUDED.per_minute_message_limit,
        is_active = true
      RETURNING id
    `);
    const organization = await client.query<{ id: string }>(`
      INSERT INTO organizations (name, slug)
      VALUES ($1, $2)
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `, [requiredSeedValue("SEED_ORG_NAME", "شركة تجريبية"), requiredSeedValue("SEED_ORG_SLUG", "demo")]);
    const organizationId = organization.rows[0]?.id;
    const planId = plan.rows[0]?.id;
    if (!organizationId || !planId) throw new Error("Could not create seed organization and plan.");
    await client.query(`
      INSERT INTO users (organization_id, email, display_name, role, status, invited_at)
      VALUES ($1, lower($2), 'Development Owner', 'owner', 'invited', now())
      ON CONFLICT (organization_id, email) DO NOTHING
    `, [organizationId, requiredSeedValue("SEED_ADMIN_EMAIL", "admin@example.invalid")]);
    await client.query(`
      INSERT INTO subscriptions (
        organization_id, plan_id, status, current_period_start, current_period_end
      )
      VALUES ($1, $2, 'active', date_trunc('month', now()), date_trunc('month', now()) + interval '1 month')
      ON CONFLICT (organization_id) WHERE status IN ('trialing', 'active', 'past_due', 'paused')
      DO UPDATE SET
        plan_id = EXCLUDED.plan_id,
        status = 'active',
        current_period_start = EXCLUDED.current_period_start,
        current_period_end = EXCLUDED.current_period_end,
        messages_used = CASE
          WHEN subscriptions.current_period_start = EXCLUDED.current_period_start
            AND subscriptions.current_period_end = EXCLUDED.current_period_end
          THEN subscriptions.messages_used
          ELSE 0
        END
    `, [organizationId, planId]);
    await client.query(`
      INSERT INTO devices (organization_id, name, provider, status)
      SELECT $1, 'Mock Android Device', 'mock', 'active'
      WHERE NOT EXISTS (SELECT 1 FROM devices WHERE organization_id = $1 AND provider = 'mock' AND status = 'active')
    `, [organizationId]);
    const generated = generateApiKey(config.API_KEY_HASH_SECRET, "test");
    await client.query(`
      INSERT INTO api_keys (organization_id, name, key_prefix, key_hash, scopes)
      VALUES ($1, $2, $3, $4, ARRAY[
        'messages:write', 'messages:read', 'usage:read', 'opt_outs:write',
        'contacts:read', 'contacts:write'
      ])
    `, [organizationId, `Development ${Date.now()}`, generated.prefix, generated.hash]);
    await client.query("COMMIT");
    process.stdout.write("Development data created. Copy this API key now; it is never stored in plaintext:\n\n");
    process.stdout.write(`${generated.rawKey}\n`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  seed().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
