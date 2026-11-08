import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = fileURLToPath(new URL("../", import.meta.url));

// This file contains public deployment coordinates only. OAuth secrets belong
// in Wrangler's secret store (or ignored .dev.vars for local development).
function deploymentEnvironment() {
  const file = path.join(projectRoot, ".env.deploy");
  const values = {};
  if (fs.existsSync(file)) {
    for (const [index, line] of fs.readFileSync(file, "utf8").split(/\r?\n/).entries()) {
      const entry = line.trim();
      if (!entry || entry.startsWith("#")) continue;
      const match = entry.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (!match) throw new Error(`Invalid .env.deploy assignment on line ${index + 1}.`);
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      values[match[1]] = value;
    }
  }
  return { ...values, ...process.env };
}

function origin(value, name, preview) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be a complete HTTPS origin.`); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || (url.protocol !== "https:" && !(preview && loopback && url.protocol === "http:"))) {
    throw new Error(`${name} must be an HTTPS origin without credentials, path, query or fragment. HTTP loopback is allowed with --preview only.`);
  }
  if (!preview && (loopback || /(?:^|\.)(?:invalid|example|test|localhost)$/.test(url.hostname) || /YOUR_|REPLACE|CHANGE_ME/i.test(url.hostname))) {
    throw new Error(`${name} still points to a placeholder or local address.`);
  }
  return url.origin;
}

export function readWebsiteSettings({ preview = false } = {}) {
  const env = deploymentEnvironment();
  const settings = {
    // Preview must stay local even after .env.deploy contains production URLs.
    API_ORIGIN: origin(preview ? "http://127.0.0.1:8787" : env.NABDA_API_ORIGIN, "NABDA_API_ORIGIN", preview),
    WEBSITE_ORIGIN: origin(preview ? "http://127.0.0.1:5174" : env.NABDA_WEBSITE_ORIGIN, "NABDA_WEBSITE_ORIGIN", preview),
    preview,
  };
  if (settings.API_ORIGIN === settings.WEBSITE_ORIGIN) throw new Error("NABDA_API_ORIGIN and NABDA_WEBSITE_ORIGIN must be different: the API root redirects to the website.");
  return settings;
}

export function readDeploymentSettings({ preview = false } = {}) {
  const env = deploymentEnvironment();
  const workerName = preview ? "nabda-api-preview" : env.NABDA_WORKER_NAME || "nabda-api";
  const databaseName = preview ? "nabda-api-preview" : env.NABDA_D1_DATABASE_NAME || "nabda-api";
  const databaseId = preview ? "00000000-0000-4000-8000-000000000000" : env.NABDA_D1_DATABASE_ID || "";
  const GITHUB_CLIENT_ID = (preview ? env.NABDA_PREVIEW_GITHUB_CLIENT_ID : env.NABDA_GITHUB_CLIENT_ID) || "";
  if (!/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(workerName)) throw new Error("NABDA_WORKER_NAME must be a lowercase Workers name (2–63 letters, digits or hyphens).");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(databaseName)) throw new Error("NABDA_D1_DATABASE_NAME is invalid.");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(databaseId) || (!preview && /^00000000-0000-/.test(databaseId))) {
    throw new Error("Set NABDA_D1_DATABASE_ID to the database UUID returned by wrangler d1 create.");
  }
  if ((!preview && !GITHUB_CLIENT_ID) || (GITHUB_CLIENT_ID && (!/^[A-Za-z0-9._-]{6,128}$/.test(GITHUB_CLIENT_ID) || /YOUR_|REPLACE|CHANGE_ME/i.test(GITHUB_CLIENT_ID)))) {
    throw new Error("Set NABDA_GITHUB_CLIENT_ID to your GitHub OAuth App's public Client ID.");
  }
  return {
    ...readWebsiteSettings({ preview }),
    GITHUB_CLIENT_ID, workerName, databaseId, databaseName, preview,
  };
}

export function cloudflareConfiguration(settings) {
  return {
    $schema: "./node_modules/wrangler/config-schema.json",
    name: settings.workerName,
    main: "worker/cloudflare.ts",
    // Match the project's pinned Wrangler/workerd runtime. A future date can
    // pass deploy --dry-run yet prevent the local worker from starting.
    compatibility_date: "2026-05-15",
    workers_dev: true,
    send_metrics: false,
    assets: {
      directory: "./deploy-build/cloudflare-assets",
      binding: "ASSETS",
      run_worker_first: ["/", "/dashboard*", "/auth/*", "/api/*", "/v1/*", "/health", "/docs*", "/download", "/help", "/support", "/privacy", "/terms"],
    },
    d1_databases: [{ binding: "DB", database_name: settings.databaseName, database_id: settings.databaseId, migrations_dir: "./drizzle" }],
    vars: { API_ORIGIN: settings.API_ORIGIN, WEBSITE_ORIGIN: settings.WEBSITE_ORIGIN, GITHUB_CLIENT_ID: settings.GITHUB_CLIENT_ID },
    dev: { ip: "127.0.0.1", port: 8787, local_protocol: "http" },
    observability: { enabled: false },
  };
}

export function writeCloudflareConfig(settings) {
  const output = path.join(projectRoot, "wrangler.nabda.json");
  fs.writeFileSync(output, JSON.stringify(cloudflareConfiguration(settings), null, 2) + "\n", { mode: 0o600 });
  return output;
}
