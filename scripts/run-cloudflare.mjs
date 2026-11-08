import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { projectRoot, readDeploymentSettings, writeCloudflareConfig } from "./cloudflare-config.mjs";

const [mode, ...args] = process.argv.slice(2);
const modes = ["dev", "check", "deploy", "migrate-local", "migrate-remote", "secret"];
if (!modes.includes(mode) || args.some((arg) => arg !== "--preview")) throw new Error(`Expected one of ${modes.join(", ")} and optional --preview.`);
const preview = args.includes("--preview");
if (preview && ["deploy", "migrate-remote", "secret"].includes(mode)) throw new Error("Preview configuration cannot create or modify remote resources.");
const settings = readDeploymentSettings({ preview });
const config = writeCloudflareConfig(settings);
const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
function run(script, parameters) {
  const result = spawnSync(process.execPath, [script, ...parameters], { cwd: projectRoot, stdio: "inherit", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (["dev", "check", "deploy"].includes(mode)) run(fileURLToPath(new URL("./build-cloudflare.mjs", import.meta.url)), preview ? ["--preview"] : []);
const common = ["--config", config];
if (mode === "dev") run(wrangler, ["dev", ...common, "--local", "--persist-to", ".wrangler/independent", "--inspector-port", "0"]);
if (mode === "check") run(wrangler, ["deploy", ...common, "--dry-run", "--outdir", "deploy-build/cloudflare-worker"]);
if (mode === "deploy") run(wrangler, ["deploy", ...common]);
if (mode === "migrate-local") run(wrangler, ["d1", "migrations", "apply", "DB", ...common, "--local", "--persist-to", ".wrangler/independent"]);
if (mode === "migrate-remote") run(wrangler, ["d1", "migrations", "apply", "DB", ...common, "--remote"]);
if (mode === "secret") {
  // Wrangler reads the value directly from its own hidden prompt/stdin.
  // It is never placed in process arguments, generated config or website files.
  if (!fs.existsSync(config)) throw new Error("Generate the deployment configuration first.");
  run(wrangler, ["secret", "put", "GITHUB_CLIENT_SECRET", ...common]);
}
