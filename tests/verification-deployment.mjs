import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readDeploymentSettings, readWebsiteSettings } from "../scripts/cloudflare-config.mjs";

// Public configuration only. Never authenticate, call a provider or modify D1.
const values = {
  NABDA_API_ORIGIN: "https://nabda-config-fixture.workers.dev",
  NABDA_WEBSITE_ORIGIN: "https://nabda-config-fixture.netlify.app",
  NABDA_WORKER_NAME: "nabda-config-fixture",
  NABDA_D1_DATABASE_NAME: "nabda-config-fixture",
  NABDA_D1_DATABASE_ID: "a1234567-1234-4234-a234-123456789abc",
  NABDA_GITHUB_CLIENT_ID: "fixture-public-client-id",
  NABDA_PREVIEW_GITHUB_CLIENT_ID: "",
};
const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
let checks = 0;
function check(name, action) { action(); checks++; console.log(`PASS ${name}`); }
try {
  Object.assign(process.env, values);
  check("production configuration uses the owner's public coordinates", () => {
    const settings = readDeploymentSettings();
    assert.equal(settings.API_ORIGIN, values.NABDA_API_ORIGIN);
    assert.equal(settings.databaseId, values.NABDA_D1_DATABASE_ID);
    assert.equal(settings.GITHUB_CLIENT_ID, values.NABDA_GITHUB_CLIENT_ID);
    assert.equal(settings.preview, false);
  });
  check("local preview cannot inherit production URLs, database identity or sign-in app", () => {
    const settings = readDeploymentSettings({ preview: true });
    assert.equal(settings.API_ORIGIN, "http://127.0.0.1:8787");
    assert.equal(settings.WEBSITE_ORIGIN, "http://127.0.0.1:5174");
    assert.equal(settings.workerName, "nabda-api-preview");
    assert.equal(settings.databaseName, "nabda-api-preview");
    assert.equal(settings.databaseId, "00000000-0000-4000-8000-000000000000");
    assert.equal(settings.GITHUB_CLIENT_ID, "");
    assert.equal(readWebsiteSettings({ preview: true }).API_ORIGIN, settings.API_ORIGIN);
  });
  check("website builds do not require D1 or GitHub configuration", () => {
    process.env.NABDA_D1_DATABASE_ID = "";
    process.env.NABDA_GITHUB_CLIENT_ID = "";
    assert.equal(readWebsiteSettings().WEBSITE_ORIGIN, values.NABDA_WEBSITE_ORIGIN);
    assert.throws(() => readDeploymentSettings(), /database UUID/);
    Object.assign(process.env, values);
  });
  check("production refuses local and placeholder addresses", () => {
    for (const address of ["http://127.0.0.1:8787", "https://localhost", "https://YOUR_API.workers.dev", "https://api.invalid"]) {
      process.env.NABDA_API_ORIGIN = address;
      assert.throws(() => readWebsiteSettings());
    }
    Object.assign(process.env, values);
  });
  check("production rejects URL paths, credentials, queries and fragments", () => {
    for (const address of [values.NABDA_API_ORIGIN + "/dashboard", "https://user:password@api-host.net", values.NABDA_API_ORIGIN + "?query=1", values.NABDA_API_ORIGIN + "#fragment"]) {
      process.env.NABDA_API_ORIGIN = address;
      assert.throws(() => readWebsiteSettings());
    }
    Object.assign(process.env, values);
  });
  check("separate hosting origins cannot create a root redirect loop", () => {
    process.env.NABDA_WEBSITE_ORIGIN = values.NABDA_API_ORIGIN;
    assert.throws(() => readWebsiteSettings(), /must be different/);
    Object.assign(process.env, values);
  });
  check("optional local OAuth configuration uses a separately selected Client ID", () => {
    process.env.NABDA_PREVIEW_GITHUB_CLIENT_ID = "fixture-local-client-id";
    assert.equal(readDeploymentSettings({ preview: true }).GITHUB_CLIENT_ID, "fixture-local-client-id");
    assert.equal(readDeploymentSettings().GITHUB_CLIENT_ID, values.NABDA_GITHUB_CLIENT_ID);
    Object.assign(process.env, values);
  });
  check("preview cannot deploy, migrate remotely or set a remote secret", () => {
    const command = fileURLToPath(new URL("../scripts/run-cloudflare.mjs", import.meta.url));
    for (const action of ["deploy", "migrate-remote", "secret"]) {
      const result = spawnSync(process.execPath, [command, action, "--preview"], { encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Preview configuration cannot create or modify remote resources/);
    }
  });
  console.log(`Deployment configuration: ${checks}/8 checks passed. No provider requests or SMS.`);
} finally {
  for (const [key, value] of Object.entries(before)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
