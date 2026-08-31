import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(projectRoot, ".vercel-static");

const requiredSources = [
  "public/index.html",
  "public/styles.css",
  "public/app.js",
  "docs/openapi.yaml",
  "docs/postman/nabda-api.postman_collection.json",
  "docs/postman/nabda-local.postman_environment.json",
  "assets/nabda-og.png",
];

for (const relativePath of requiredSources) {
  const sourcePath = path.join(projectRoot, relativePath);
  const sourceStat = await stat(sourcePath).catch(() => null);
  if (!sourceStat?.isFile()) {
    throw new Error(`Required static deployment source is missing: ${relativePath}`);
  }
}

await rm(outputDirectory, { force: true, recursive: true });
await cp(path.join(projectRoot, "public"), outputDirectory, { recursive: true });
await rm(path.join(outputDirectory, "pricing 2.html"), { force: true });
await mkdir(path.join(outputDirectory, "downloads"), { recursive: true });

await Promise.all([
  cp(
    path.join(projectRoot, "docs/openapi.yaml"),
    path.join(outputDirectory, "openapi.yaml"),
  ),
  cp(
    path.join(projectRoot, "docs/postman/nabda-api.postman_collection.json"),
    path.join(outputDirectory, "downloads/nabda-api.postman_collection.json"),
  ),
  cp(
    path.join(projectRoot, "docs/postman/nabda-local.postman_environment.json"),
    path.join(outputDirectory, "downloads/nabda-local.postman_environment.json"),
  ),
  cp(
    path.join(projectRoot, "assets/nabda-og.png"),
    path.join(outputDirectory, "og.png"),
  ),
]);

console.log("Prepared the httpSMS Desktop static site for Vercel in .vercel-static/.");
