import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { app, dialog, Menu, nativeImage, shell, Tray } from "electron";
import { LocalController } from "./controller/controller.js";
import { startControllerServer, type ControllerServer } from "./controller/server.js";
import { DesktopDatabase } from "./core/database.js";

let tray: Tray | undefined;
let server: ControllerServer | undefined;
let database: DesktopDatabase | undefined;
let controller: LocalController | undefined;
let quitting = false;

// Keep the pre-rename data directory so changing the visible product name never
// hides an existing queue, pairing, settings, or contact book.
const persistentUserDataPath = join(app.getPath("appData"), app.isPackaged ? "Nabda Controller" : "nabda-api-saas");
app.setPath("userData", persistentUserDataPath);
app.setName("نبضة");

function privateIpv4(): string {
  const candidates = Object.values(networkInterfaces()).flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address)
    .filter((address) => /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(address));
  return candidates[0] ?? "127.0.0.1";
}

async function openDashboard(): Promise<void> {
  if (server) await shell.openExternal(server.dashboardUrl);
}

function rebuildTrayMenu(): void {
  if (!tray || !controller || !server) return;
  const launchAtLogin = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open نبضة", click: () => void openDashboard() },
    { label: `Phone gateway: ${controller.liveEnabled ? "enabled" : "locked"}`, enabled: false },
    { label: `Android URL: ${server.lanUrl}`, enabled: false },
    { type: "separator" },
    {
      label: "Start with Windows",
      type: "checkbox",
      checked: launchAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ["--background"] }),
    },
    {
      label: "Lock carrier sending",
      enabled: controller.liveEnabled,
      click: () => { controller?.setLiveEnabled(false); rebuildTrayMenu(); },
    },
    { type: "separator" },
    { label: "Quit نبضة", click: () => { quitting = true; app.quit(); } },
  ]));
}

async function bootstrap(): Promise<void> {
  app.setAppUserModelId("com.nabda.controller");
  database = new DesktopDatabase(join(app.getPath("userData"), "nabda-controller.sqlite3"));
  controller = new LocalController(database);
  server = await startControllerServer({ controller, lanAddress: privateIpv4(), port: 3210 });

  const icon = nativeImage.createFromPath(join(app.getAppPath(), "build", "icon.png")).resize({ width: 20, height: 20 });
  tray = new Tray(icon);
  tray.setToolTip("نبضة — running in the background");
  tray.on("click", () => void openDashboard());
  rebuildTrayMenu();
  if (!process.argv.includes("--background")) await openDashboard();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => void openDashboard());
  app.whenReady().then(bootstrap).catch((issue: unknown) => {
    dialog.showErrorBox("نبضة could not start", issue instanceof Error ? issue.message : String(issue));
    quitting = true;
    app.quit();
  });
}

app.on("window-all-closed", () => { /* The tray controller intentionally stays in the background. */ });
app.on("before-quit", (event) => {
  if (quitting && server) {
    event.preventDefault();
    const active = server;
    server = undefined;
    void active.close().catch(() => undefined).finally(() => {
      database?.close();
      database = undefined;
      app.exit(0);
    });
  }
});
