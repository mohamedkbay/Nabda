import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { generateApiKey } from "../lib/crypto.js";
import { createPostgresPool } from "./pool.js";

function freeValue(name: string, fallback: string): string {
  const value = String(process.env[name] || fallback).trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export async function provisionDevelopmentFreePlan(): Promise<void> {
  const config = loadConfig();
  if (config.NODE_ENV === "production") {
    throw new Error("Local free-plan provisioning is disabled in production.");
  }

  const pool = createPostgresPool(config.DATABASE_URL, config.DB_POOL_MAX);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '10s'");

    const planResult = await client.query<{ id: string; monthly_message_limit: string }>(`
      SELECT id, monthly_message_limit
      FROM plans
      WHERE code = 'free' AND is_active = true
      LIMIT 1
      FOR SHARE
    `);
    const plan = planResult.rows[0];
    if (!plan || Number(plan.monthly_message_limit) !== 5000) {
      throw new Error("The Free plan is unavailable. Run the database migrations first.");
    }

    const organizationResult = await client.query<{ id: string }>(`
      INSERT INTO organizations (name, slug)
      VALUES ($1, $2)
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `, [
      freeValue("FREE_ORG_NAME", "Local Free Organization"),
      freeValue("FREE_ORG_SLUG", "local-free"),
    ]);
    const organizationId = organizationResult.rows[0]?.id;
    if (!organizationId) throw new Error("Could not create the Free organization.");

    await client.query(`
      INSERT INTO users (organization_id, email, display_name, role, status, invited_at)
      VALUES ($1, lower($2), 'Free Plan Owner', 'owner', 'invited', now())
      ON CONFLICT (organization_id, email) DO NOTHING
    `, [organizationId, freeValue("FREE_ADMIN_EMAIL", "free@example.invalid")]);

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
        trial_ends_at = NULL,
        messages_used = CASE
          WHEN subscriptions.current_period_start = EXCLUDED.current_period_start
            AND subscriptions.current_period_end = EXCLUDED.current_period_end
          THEN subscriptions.messages_used
          ELSE 0
        END,
        updated_at = now()
    `, [organizationId, plan.id]);

    await client.query(`
      INSERT INTO devices (organization_id, name, provider, status)
      SELECT $1, 'Free Mock Device', 'mock', 'active'
      WHERE NOT EXISTS (
        SELECT 1 FROM devices
        WHERE organization_id = $1 AND provider = 'mock' AND status = 'active'
      )
    `, [organizationId]);

    await client.query(`
      UPDATE api_keys
      SET revoked_at = now(), revoked_reason = 'local_free_key_rotated', updated_at = now()
      WHERE organization_id = $1
        AND name = 'Free API key'
        AND revoked_at IS NULL
    `, [organizationId]);

    const generated = generateApiKey(
      config.API_KEY_HASH_SECRET,
      config.ENABLE_ANDROID_AGENT_LIVE_REPORTING ? "live" : "test",
    );
    await client.query(`
      INSERT INTO api_keys (organization_id, name, key_prefix, key_hash, scopes)
      VALUES ($1, $2, $3, $4, ARRAY[
        'messages:write', 'messages:read', 'usage:read', 'opt_outs:write',
        'contacts:read', 'contacts:write'
      ])
    `, [organizationId, "Free API key", generated.prefix, generated.hash]);

    await client.query("COMMIT");
    process.stdout.write("Permanent Free plan ready. Copy this test API key now; it is never stored in plaintext:\n\n");
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
  provisionDevelopmentFreePlan().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
