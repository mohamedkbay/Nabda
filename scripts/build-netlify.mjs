import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readWebsiteSettings } from "./cloudflare-config.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--preview") || args.length > 1) throw new Error("Usage: node scripts/build-netlify.mjs [--preview]");
const settings = readWebsiteSettings({ preview: args.includes("--preview") });
const output = path.join(root, "deploy-build/netlify");
const sourceApiOrigin = "https://api.example.invalid";
const sourceWebsiteOrigin = "https://nabda.example.invalid";
const { API_ORIGIN: api, WEBSITE_ORIGIN: website } = settings;

// Explicit public allowlist: never walk the checkout or copy a secret/config file.
const files = ["favicon.svg", "story/style.css", "story/pattern.svg", "fonts/cairo-regular.ttf", "fonts/cairo-semibold.ttf", "fonts/caveat-medium.ttf", "fonts/Cairo-OFL.txt", "fonts/Caveat-OFL.txt", "illustrations/nabda-workshop-cutout.webp", "illustrations/nabda-pairing-cutout.webp", "illustrations/nabda-phone-queue-cutout.webp", "illustrations/nabda-message-parts-cutout.webp", "downloads/Nabda-Android-0.2.0.apk", "downloads/THIRD-PARTY-NOTICES.txt", "api-kit/nabda.mjs", "api-kit/nabda.py", "api-kit/Nabda.postman_collection.json", "api-kit/Nabda.postman_environment.json"];
const publicRoot = await fs.realpath(path.join(root, "public"));
const contents = await Promise.all(files.map(async (name) => {
  const source = await fs.realpath(path.join(publicRoot, name));
  if (!source.startsWith(publicRoot + path.sep) || !(await fs.stat(source)).isFile()) throw new Error(`Refusing non-public file: ${name}`);
  return [name, await fs.readFile(source)];
}));
let html = await fs.readFile(path.join(root, "content/story.html"), "utf8");
html = html.replaceAll(sourceWebsiteOrigin, website)
  .replaceAll(sourceApiOrigin, api)
  .replaceAll('href="/dashboard"', `href="${api}/dashboard"`);
if (/chatgpt|openai|Sites-managed/i.test(html)) throw new Error("The independent page still contains a legacy hosting reference.");
let readme = await fs.readFile(path.join(publicRoot, "api-kit/README.md"), "utf8");
readme = readme.replace("Open your API server's `/dashboard` and sign in with GitHub.", `Open ${api}/dashboard and sign in with GitHub.`)
  .replaceAll("https://YOUR_NABDA_SITE", api)
  .replaceAll("https://YOUR_NABDA_API_HOST", api)
  .replace("Use your configured Nabda API origin for requests and the dashboard. The illustrated website is hosted separately.", `The API and account dashboard are at ${api}. The public illustrated website is at ${website}.`);
if (/chatgpt|openai|Sites-managed/i.test(readme)) throw new Error("The independent starter guide still contains a legacy hosting reference.");

await fs.rm(output, { recursive: true, force: true });
for (const [name, data] of contents) {
  const destination = path.join(output, name);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, data);
}
await fs.writeFile(path.join(output, "index.html"), html);
await fs.writeFile(path.join(output, "api-kit/README.md"), readme);
function run(script, values) {
  const result = spawnSync(process.execPath, [path.join(root, script), ...values], { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${script} failed: ${result.stderr || result.error?.message || "unknown error"}`);
  process.stdout.write(result.stdout);
}
run("scripts/generate-openapi.mjs", ["--hosting", "independent", "--api-origin", api, "--output", path.join(output, "openapi.json")]);
run("scripts/package-free-kit.mjs", ["--public-dir", output]);
const sections = { "how-it-works": "idea", download: "setup", help: "questions", support: "support", privacy: "privacy", terms: "terms", docs: "api", "docs/installation": "setup", "docs/authentication": "api", "docs/testing": "request", "docs/limits": "limits", "docs/queue": "queue", "docs/messages": "request" };
const redirects = Object.entries(sections).map(([route, anchor]) => `/${route} /#${anchor} 301`).join("\n");
await fs.writeFile(path.join(output, "_redirects"), `${redirects}\n/dashboard ${api}/dashboard 302\n/dashboard/* ${api}/dashboard 302\n/docs/* /#api 301\n`);
await fs.writeFile(path.join(output, "_headers"), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Content-Security-Policy: default-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
/downloads/*.apk
  Content-Type: application/vnd.android.package-archive
  Content-Disposition: attachment
/api-kit/*
  X-Content-Type-Options: nosniff
`);
await fs.writeFile(path.join(output, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${website}/sitemap.xml\n`);
await fs.writeFile(path.join(output, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${website}/</loc></url></urlset>\n`);
await fs.writeFile(path.join(output, "404.html"), '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found — Nabda</title><link rel="stylesheet" href="/story/style.css"><main class="storybook"><section class="chapter"><h1>This page wandered off.</h1><p><a href="/">Back to Nabda</a></p></section></main></html>\n');
await fs.writeFile(path.join(root, "deploy-build/netlify-build.json"), JSON.stringify({ mode: settings.preview ? "preview-only" : "production-ready", website_origin: website, api_origin: api, output: "deploy-build/netlify", secrets_included: false }, null, 2) + "\n");
console.log(`Netlify static export: ${output} (${settings.preview ? "PREVIEW ONLY — localhost links" : "configured external origins"}).`);
