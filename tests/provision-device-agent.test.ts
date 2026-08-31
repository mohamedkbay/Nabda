import { describe, expect, it } from "vitest";
import { resolveDeviceAgentProvisionMode } from "../src/db/provision-device-agent.js";

const simulationConfig = {
  NODE_ENV: "development" as const,
  ENABLE_ANDROID_AGENT: true,
  ENABLE_ANDROID_AGENT_LIVE_REPORTING: false,
  ENABLE_LIVE_SMS: false,
};

describe("Android device credential provisioning mode", () => {
  it("defaults every local credential to simulation", () => {
    expect(resolveDeviceAgentProvisionMode(simulationConfig, {})).toBe("simulation");
  });

  it("rejects a live credential outside an explicitly enabled production server", () => {
    expect(() => resolveDeviceAgentProvisionMode(simulationConfig, {
      DEVICE_AGENT_MODE: "live",
      CONFIRM_LIVE_DEVICE_AGENT_PROVISION: "PROVISION_LIVE_ANDROID_AGENT",
    })).toThrow(/requires production/);
  });

  it("requires a second exact confirmation before provisioning a live production credential", () => {
    const liveConfig = {
      NODE_ENV: "production" as const,
      ENABLE_ANDROID_AGENT: true,
      ENABLE_ANDROID_AGENT_LIVE_REPORTING: true,
      ENABLE_LIVE_SMS: true,
    };
    expect(() => resolveDeviceAgentProvisionMode(liveConfig, { DEVICE_AGENT_MODE: "live" }))
      .toThrow(/CONFIRM_LIVE_DEVICE_AGENT_PROVISION/);
    expect(resolveDeviceAgentProvisionMode(liveConfig, {
      DEVICE_AGENT_MODE: "live",
      CONFIRM_LIVE_DEVICE_AGENT_PROVISION: "PROVISION_LIVE_ANDROID_AGENT",
    })).toBe("live");
  });
});
