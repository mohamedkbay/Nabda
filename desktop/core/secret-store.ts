export interface SecretStore {
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

function assertSecretKey(key: string): void {
  if (!/^[a-z][a-z0-9._-]{1,79}$/i.test(key)) throw new Error("Invalid secret key");
}

export class MemorySecretStore implements SecretStore {
  private readonly secrets = new Map<string, string>();

  async set(key: string, value: string): Promise<void> {
    assertSecretKey(key);
    if (value.length < 1 || value.length > 16_384) throw new Error("Invalid secret value");
    this.secrets.set(key, value);
  }

  async get(key: string): Promise<string | null> {
    assertSecretKey(key);
    return this.secrets.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    assertSecretKey(key);
    this.secrets.delete(key);
  }
}

export class SettingsSecretService {
  constructor(private readonly store: SecretStore) {}

  async saveProviderSecret(value: string): Promise<void> {
    await this.store.set("provider.api-key", value);
  }

  async readProviderSecret(): Promise<string | null> {
    return this.store.get("provider.api-key");
  }

  async clearProviderSecret(): Promise<void> {
    await this.store.delete("provider.api-key");
  }

  async hasProviderSecret(): Promise<boolean> {
    return (await this.readProviderSecret()) !== null;
  }
}
