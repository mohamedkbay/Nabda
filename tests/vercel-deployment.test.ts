import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "..");

describe("Vercel static deployment", () => {
  it("overrides function inference with an explicit static output", () => {
    const config = JSON.parse(
      readFileSync(path.join(projectRoot, "vercel.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(config.buildCommand).toBe("npm run vercel:build");
    expect(config.outputDirectory).toBe(".vercel-static");
    expect(config.cleanUrls).toBe(true);
    expect(config.functions).toBeUndefined();
    expect(config.builds).toBeUndefined();
  });

  it("builds only the website and documented download artifacts", () => {
    execFileSync(process.execPath, ["scripts/build-vercel-static.mjs"], {
      cwd: projectRoot,
      stdio: "pipe",
    });

    const expectedFiles = [
      "index.html",
      "integration.html",
      "api.html",
      "webhooks.html",
      "pricing.html",
      "get-started.html",
      "help.html",
      "legal.html",
      "styles.css",
      "app.js",
      "og.png",
      "openapi.yaml",
      "downloads/nabda-api.postman_collection.json",
      "downloads/nabda-local.postman_environment.json",
      "fonts/cairo-latin-wght-normal.woff2",
    ];

    for (const relativePath of expectedFiles) {
      expect(existsSync(path.join(projectRoot, ".vercel-static", relativePath)))
        .toBe(true);
    }

    expect(existsSync(path.join(projectRoot, ".vercel-static/src/app.js")))
      .toBe(false);
    expect(existsSync(path.join(projectRoot, ".vercel-static/pricing 2.html")))
      .toBe(false);
  });
});
