import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SecretVault } from "../desktop/security/secret-vault.js";

describe("Windows background controller security policy", () => {
  it("ships an English browser dashboard for messages, contacts, campaigns, and devices", async () => {
    const html = await readFile(join(process.cwd(), "desktop/controller/web/index.html"), "utf8");
    const css = await readFile(join(process.cwd(), "desktop/controller/web/styles.css"), "utf8");
    const renderer = await readFile(join(process.cwd(), "desktop/controller/web/app.js"), "utf8");
    expect(html).toContain("Nabda Controller");
    expect(html).toContain('lang="en"');
    for (const page of ["overview", "messages", "contacts", "campaign", "device"]) expect(html).toContain(`id="${page}"`);
    expect(css).toContain("button:focus-visible");
    expect(css).toContain("@font-face");
    expect(renderer).toContain('"x-nabda-control":"1"');
    expect(renderer).toContain("/control-api/campaigns");
    expect(renderer).not.toContain("x-api-key");
    expect(html).not.toContain("httpSMS");
  });

  it("uses the system browser and stays alive as a single background tray process", async () => {
    const source = await readFile(join(process.cwd(), "desktop/main.ts"), "utf8");
    expect(source).toContain("new Tray");
    expect(source).toContain("shell.openExternal");
    expect(source).toContain("requestSingleInstanceLock");
    expect(source).toContain("Start with Windows");
    expect(source).not.toContain("BrowserWindow");
  });

  it("keeps browser controls loopback-only and Android behind a hashed bearer token", async () => {
    const server = await readFile(join(process.cwd(), "desktop/controller/server.ts"), "utf8");
    const controller = await readFile(join(process.cwd(), "desktop/controller/controller.ts"), "utf8");
    expect(server).toContain("local_browser_only");
    expect(server).toContain("SameSite=Strict");
    expect(server).toContain("x-nabda-control");
    expect(server).toContain("frame-ancestors 'none'");
    expect(controller).toContain('hash("device", token)');
    expect(controller).toContain("timingSafeEqual");
    expect(controller).toContain("MIN_DISPATCH_INTERVAL_MS = 6_000");
    expect(controller).not.toContain("httpSMS");
  });

  it("cleans generated desktop output before packaging", async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.["build:desktop"]).toContain("clean-desktop-dist.mjs");
  });
});

describe("SecretVault", () => {
  it("stores only encrypted bytes and recovers the secret through OS storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "httpsms-desktop-vault-"));
    const storage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`cipher:${Buffer.from(value).toString("base64")}`),
      decryptString: (value: Buffer) => Buffer.from(value.toString().slice(7), "base64").toString(),
    };
    const vault = new SecretVault(directory, storage);
    try {
      await vault.save("provider-secret-value");
      const raw = await readFile(join(directory, "secure", "provider-secret.bin"));
      expect(raw.toString()).not.toContain("provider-secret-value");
      expect(await vault.hasSecret()).toBe(true);
      expect(await vault.read()).toBe("provider-secret-value");
      await vault.clear();
      expect(await vault.hasSecret()).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses plaintext fallback when OS encryption is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "httpsms-desktop-vault-"));
    const vault = new SecretVault(directory, {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.from("must-not-run"),
      decryptString: () => "must-not-run",
    });
    try {
      await expect(vault.save("provider-secret-value")).rejects.toThrow("encryption is unavailable");
      expect(await vault.hasSecret()).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
