import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Android phone permission flow", () => {
  it("requests live carrier permissions on launch without adding them to simulation", async () => {
    const root = join(process.cwd(), "android-agent/app/src");
    const activity = await readFile(join(root, "main/java/com/nabda/agent/MainActivity.java"), "utf8");
    const liveGate = await readFile(join(root, "live/java/com/nabda/agent/TransportGate.java"), "utf8");
    const simulationGate = await readFile(join(root, "simulation/java/com/nabda/agent/TransportGate.java"), "utf8");
    const baseManifest = await readFile(join(root, "main/AndroidManifest.xml"), "utf8");
    const liveManifest = await readFile(join(root, "live/AndroidManifest.xml"), "utf8");

    expect(activity).toContain("transportGate.requestPermissionsOnLaunch()");
    expect(liveGate).toContain("requestPermissionsOnLaunch");
    expect(liveGate).toContain("requestCarrierPermissions()");
    expect(simulationGate).toContain("Simulation is intentionally permission-free");
    expect(baseManifest).not.toContain("android.permission.SEND_SMS");
    expect(liveManifest).toContain("android.permission.SEND_SMS");
  });
});
