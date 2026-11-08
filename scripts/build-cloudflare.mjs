import fs from "node:fs/promises";
import path from "node:path";
import { build } from "vite";
import { projectRoot, readDeploymentSettings, writeCloudflareConfig } from "./cloudflare-config.mjs";
import { dashboardConfig } from "../deployment/dashboard/vite.config.mjs";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--preview")) throw new Error("Usage: npm run build:cloudflare -- [--preview]");
const settings = readDeploymentSettings({ preview: args.includes("--preview") });
await build(dashboardConfig(settings));
const assets = path.join(projectRoot, "deploy-build/cloudflare-assets");
await fs.mkdir(path.join(assets, "dashboard"), { recursive: true });
await fs.rename(path.join(assets, "index.html"), path.join(assets, "dashboard/index.html"));
await fs.cp(path.join(projectRoot, "public/fonts"), path.join(assets, "fonts"), { recursive: true });
await fs.copyFile(path.join(projectRoot, "public/favicon.svg"), path.join(assets, "favicon.svg"));
const config = writeCloudflareConfig(settings);
console.log(`Cloudflare dashboard built. Configuration: ${path.relative(projectRoot, config)}`);
if (settings.preview) console.log("Preview only: no hosting accounts, secrets or live resources were used. Deployment requires your real deployment settings.");
