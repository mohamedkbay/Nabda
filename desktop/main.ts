import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, safeStorage, session, shell } from "electron";
import type { DesktopServices } from "./contracts.js";
import { registerIpcHandlers } from "./ipc/register-handlers.js";
import { isPrivateLanAddress, LocalPairingServer } from "./network/local-pairing-server.js";
import { SecretVault } from "./security/secret-vault.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | undefined;
let pairingServer: LocalPairingServer | undefined;
let disposeIpc: (() => void) | undefined;

export async function runDesktopApp(services: DesktopServices): Promise<void> {
  const rendererPath = join(moduleDirectory, "renderer", "index.html");
  const rendererUrl = pathToFileURL(rendererPath).toString();
  // Sandboxed Electron preload scripts run in a restricted CommonJS context.
  const preloadPath = join(moduleDirectory, "preload.cjs");
  const secretVault = new SecretVault(app.getPath("userData"), safeStorage);

  const privateAddress = findPrivateLanAddress();
  if (privateAddress) {
    pairingServer = new LocalPairingServer(services, privateAddress);
    try {
      await pairingServer.start();
    } catch {
      pairingServer = undefined;
    }
  }

  mainWindow = createMainWindow(preloadPath);
  disposeIpc = registerIpcHandlers({
    ipcMain,
    window: mainWindow,
    rendererUrl,
    services,
    secretVault,
    getLanOrigin: () => {
      if (!pairingServer) throw new Error("No private LAN address is available.");
      return pairingServer.origin;
    },
  });
  await mainWindow.loadFile(rendererPath);
}

export function createMainWindow(preloadPath: string): BrowserWindow {
  const window = new BrowserWindow({
    title: "نبضة",
    width: 1_320,
    height: 840,
    minWidth: 1_040,
    minHeight: 680,
    backgroundColor: "#f4f6f3",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.once("ready-to-show", () => window.show());
  return window;
}

function findPrivateLanAddress(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal && isPrivateLanAddress(address.address)) {
        return address.address;
      }
    }
  }
  return undefined;
}

async function bootstrap(): Promise<void> {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  // Core owns SQLite, queue and providers. This import is deliberately the
  // single integration seam between Electron and desktop/core.
  const core = (await import("./integration.js")) as unknown as {
    createDesktopServices?: (input: { userDataPath: string }) => Promise<DesktopServices> | DesktopServices;
  };
  if (!core.createDesktopServices) throw new Error("Desktop core adapter is not configured.");
  await runDesktopApp(await core.createDesktopServices({ userDataPath: app.getPath("userData") }));
}

app.whenReady().then(bootstrap).catch(() => app.quit());
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  disposeIpc?.();
  void pairingServer?.stop();
});
