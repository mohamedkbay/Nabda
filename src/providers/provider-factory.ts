import type { AppConfig } from "../config.js";
import { HttpSmsProvider } from "./httpsms-provider.js";
import { MockProvider } from "./mock-provider.js";
import type { ProviderAdapter } from "./provider.js";

export interface ProviderRegistry {
  get(name: "mock" | "httpsms"): ProviderAdapter;
}

export function createProviderRegistry(config: AppConfig): ProviderRegistry {
  const provider: ProviderAdapter = config.PROVIDER_MODE === "httpsms"
    ? new HttpSmsProvider({
      apiBase: config.HTTPSMS_API_BASE,
      timeoutMs: config.PROVIDER_TIMEOUT_MS,
      liveSmsEnabled: config.ENABLE_LIVE_SMS,
      environment: config.NODE_ENV,
    })
    : new MockProvider();
  return {
    get(name) {
      if (name !== provider.name) throw new Error(`Provider ${name} is disabled.`);
      return provider;
    },
  };
}
