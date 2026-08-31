import type { ApiPrincipal } from "../domain/types.js";
import { apiKeyPrefix, verifyApiKey } from "../lib/crypto.js";
import type { Repository } from "../repositories/repository.js";

export class AuthService {
  constructor(
    private readonly repository: Repository,
    private readonly hashSecret: string,
    private readonly keyEnvironment: "live" | "test",
  ) {}

  async authenticate(rawKey: string, now = new Date()): Promise<ApiPrincipal | null> {
    const prefix = apiKeyPrefix(rawKey);
    if (!prefix) return null;
    if (!prefix.startsWith(`nbda_${this.keyEnvironment}_`)) return null;
    const record = await this.repository.findApiKeyByPrefix(prefix);
    if (!record || record.revokedAt || record.organizationStatus !== "active") return null;
    if (record.expiresAt && record.expiresAt <= now) return null;
    if (!verifyApiKey(rawKey, record.keyHash, this.hashSecret)) return null;
    void this.repository.touchApiKey(record.apiKeyId, now).catch(() => undefined);
    return {
      apiKeyId: record.apiKeyId,
      organizationId: record.organizationId,
      organizationStatus: record.organizationStatus,
      scopes: record.scopes,
    };
  }
}
