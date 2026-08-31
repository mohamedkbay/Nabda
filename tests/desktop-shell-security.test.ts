import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SecretVault } from "../desktop/security/secret-vault.js";

describe("Electron desktop security policy", () => {
  it("ships an offline, accessible top-navigation renderer", async () => {
    const html = await readFile(join(process.cwd(), "desktop/renderer/index.html"), "utf8");
    const css = await readFile(join(process.cwd(), "desktop/renderer/styles.css"), "utf8");
    const renderer = await readFile(join(process.cwd(), "desktop/renderer/app.js"), "utf8");
    expect(html).toContain('class="app-header"');
    expect(html).toContain('aria-label="القائمة الرئيسية"');
    expect(html).toContain('src="./vendor/lucide.js"');
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("httpSMS Desktop");
    expect(html).toContain("Unofficial desktop client");
    for (const icon of ["house", "users-round", "contact-round", "rows-3", "messages-square", "plug", "database-backup"]) {
      expect(html).toContain(`data-lucide="${icon}"`);
    }
    for (const page of ["dashboard", "customers", "contacts", "campaigns", "messages", "integration", "backup"]) {
      expect(html).toContain(`data-page="${page}"`);
      expect(html).toContain(`id="page-${page}"`);
    }
    expect(css).toContain("button:focus-visible");
    expect(css).toContain("touch-action:manipulation");
    expect(renderer).toContain("await api.campaigns.create");
    expect(renderer).toContain("api.messages.refreshStatuses");
    expect(renderer).not.toContain("x-api-key");
    expect(html).not.toContain('id="page-devices"');
    expect(html).not.toContain("pairing_code");
  });

  it("keeps the renderer isolated and denies Node integration", async () => {
    const source = await readFile(join(process.cwd(), "desktop/main.ts"), "utf8");
    expect(source).toContain("contextIsolation: true");
    expect(source).toContain("nodeIntegration: false");
    expect(source).toContain("sandbox: true");
    expect(source).toContain("webSecurity: true");
    expect(source).toContain('return { action: "deny" }');
    expect(source).toContain("setPermissionRequestHandler");
  });

  it("exposes named preload methods without a generic IPC escape hatch", async () => {
    const source = await readFile(join(process.cwd(), "desktop/preload.ts"), "utf8");
    const packagedSource = await readFile(join(process.cwd(), "desktop/preload.cjs"), "utf8");
    expect(source).toContain('contextBridge.exposeInMainWorld("httpSmsDesktop"');
    expect(source).not.toContain("ipcRenderer.send");
    expect(source).not.toContain("ipcRenderer.on");
    expect(source).not.toContain("ipcRenderer.removeListener");
    expect(packagedSource).toContain('contextBridge.exposeInMainWorld(');
    expect(packagedSource).not.toContain("ipcRenderer.send");
    expect(packagedSource).not.toContain("ipcRenderer.on");
  });

  it("uses the official provider adapter and keeps connection testing read-only", async () => {
    const provider = await readFile(join(process.cwd(), "desktop/core/provider.ts"), "utf8");
    const integration = await readFile(join(process.cwd(), "desktop/integration.ts"), "utf8");
    const handlers = await readFile(join(process.cwd(), "desktop/ipc/register-handlers.ts"), "utf8");
    expect(integration).toContain("new HttpSmsProvider");
    expect(integration).not.toContain('fetchImplementation(`${HTTPSMS_API}');
    expect(provider).toContain("/users/me");
    expect(provider).toContain("/messages/send");
    expect(provider).toContain('"x-api-key"');
    expect(provider).toContain("Manual review");
    expect(handlers).toContain("GET /users/me is read-only");
    await expect(access(join(process.cwd(), "desktop/network/local-pairing-server.ts"))).rejects.toThrow();
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
