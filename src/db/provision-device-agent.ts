import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type AppConfig } from "../config.js";
import type { MessageExecutionMode } from "../domain/types.js";
import { generateDeviceToken } from "../lib/crypto.js";
import { createPostgresPool } from "./pool.js";

const LIVE_PROVISION_CONFIRMATION = "PROVISION_LIVE_ANDROID_AGENT";

function value(name: string, fallback: string, environment: NodeJS.ProcessEnv = process.env): string {
  const result = String(environment[name] || fallback).trim();
  if (!result) throw new Error(`${name} is required.`);
  return result;
}

export function resolveDeviceAgentProvisionMode(
  config: Pick<
    AppConfig,
    "NODE_ENV" | "ENABLE_ANDROID_AGENT" | "ENABLE_ANDROID_AGENT_LIVE_REPORTING" | "ENABLE_LIVE_SMS"
  >,
  environment: NodeJS.ProcessEnv = process.env,
): MessageExecutionMode {
  const requested = value("DEVICE_AGENT_MODE", "simulation", environment);
  if (requested !== "simulation" && requested !== "live") {
    throw new Error("DEVICE_AGENT_MODE must be either simulation or live.");
  }
  if (!config.ENABLE_ANDROID_AGENT) {
    throw new Error("ENABLE_ANDROID_AGENT must be true to provision an Android device.");
  }
  if (requested === "live" && (
    !config.ENABLE_LIVE_SMS
    || !config.ENABLE_ANDROID_AGENT_LIVE_REPORTING
  )) {
    throw new Error(
      "Live Android provisioning requires ENABLE_LIVE_SMS=true and ENABLE_ANDROID_AGENT_LIVE_REPORTING=true.",
    );
  }
  if (requested === "live" && config.NODE_ENV !== "production"
    && environment.CONFIRM_LAN_LIVE_SMS !== "I_UNDERSTAND_LAN_LIVE_SMS") {
    throw new Error("Development LAN live mode requires CONFIRM_LAN_LIVE_SMS=I_UNDERSTAND_LAN_LIVE_SMS.");
  }
  if (requested === "live" && environment.CONFIRM_LIVE_DEVICE_AGENT_PROVISION !== LIVE_PROVISION_CONFIRMATION) {
    throw new Error(
      `Live Android provisioning requires CONFIRM_LIVE_DEVICE_AGENT_PROVISION=${LIVE_PROVISION_CONFIRMATION}.`,
    );
  }
  return requested;
}

export async function provisionDeviceAgent(): Promise<void> {
  const config = loadConfig();
  const mode = resolveDeviceAgentProvisionMode(config);

  const pool = createPostgresPool(config.DATABASE_URL, config.DB_POOL_MAX);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '10s'");
    const organization = await client.query<{ id: string }>(`
      SELECT id FROM organizations
      WHERE slug = $1 AND status = 'active'
      LIMIT 1
      FOR UPDATE
    `, [value("DEVICE_AGENT_ORG_SLUG", "local-free")]);
    const organizationId = organization.rows[0]?.id;
    if (!organizationId) {
      throw new Error("The target organization was not found. Create the local Free plan first or set DEVICE_AGENT_ORG_SLUG.");
    }

    const identity = value("DEVICE_AGENT_IDENTITY", "local-android-agent");
    const deviceResult = await client.query<{ id: string }>(`
      INSERT INTO devices (
        organization_id, name, provider, provider_external_id, status,
        provider_config, metadata, last_seen_at
      ) VALUES ($1, $2, 'android_agent', $3, 'active', $4::jsonb, $5::jsonb, now())
      ON CONFLICT (organization_id, provider, provider_external_id)
        WHERE provider_external_id IS NOT NULL
      DO UPDATE SET
        name = EXCLUDED.name,
        status = 'active',
        disabled_at = NULL,
        provider_config = EXCLUDED.provider_config,
        metadata = devices.metadata || EXCLUDED.metadata
      RETURNING id
    `, [
      organizationId,
      value("DEVICE_AGENT_NAME", "Nabda Android Device"),
      identity,
      JSON.stringify({ protocol: "pull-v1", agent_mode: mode }),
      JSON.stringify({ provisioned_by: "cli", provisioned_locally: config.NODE_ENV !== "production" }),
    ]);
    const deviceId = deviceResult.rows[0]?.id;
    if (!deviceId) throw new Error("Could not provision the Android device.");

    await client.query(`
      UPDATE device_agent_credentials SET
        revoked_at = now(),
        revoked_reason = 'local_device_token_rotated'
      WHERE organization_id = $1 AND device_id = $2 AND revoked_at IS NULL
    `, [organizationId, deviceId]);
    const generated = generateDeviceToken(config.API_KEY_HASH_SECRET);
    await client.query(`
      INSERT INTO device_agent_credentials (
        organization_id, device_id, token_prefix, token_hash, mode
      ) VALUES ($1, $2, $3, $4, $5)
    `, [organizationId, deviceId, generated.prefix, generated.hash, mode]);
    await client.query(`
      INSERT INTO audit_logs (
        organization_id, actor_type, action, resource_type, resource_id, metadata
      ) VALUES ($1, 'system', 'device_agent.provisioned', 'device', $2, $3::jsonb)
    `, [organizationId, deviceId, JSON.stringify({ identity, mode })]);
    await client.query("COMMIT");

    process.stdout.write(mode === "simulation"
      ? "Android device agent ready in simulation-only mode. No SMS will be sent.\n\n"
      : "Android device agent provisioned in LIVE mode after explicit production confirmation.\n\n");
    process.stdout.write(`Device ID: ${deviceId}\n`);
    process.stdout.write("Device token (shown once; plaintext is never stored):\n\n");
    process.stdout.write(`${generated.rawToken}\n`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  provisionDeviceAgent().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
