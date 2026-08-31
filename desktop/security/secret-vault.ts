import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SafeStorage } from "electron";

const SECRET_FILE_NAME = "provider-secret.bin";

/** Main-process-only encrypted provider-secret storage. */
export class SecretVault {
  private readonly secretPath: string;

  public constructor(
    userDataPath: string,
    private readonly storage: Pick<SafeStorage, "isEncryptionAvailable" | "encryptString" | "decryptString">,
  ) {
    this.secretPath = join(userDataPath, "secure", SECRET_FILE_NAME);
  }

  public async hasSecret(): Promise<boolean> {
    try {
      const encrypted = await readFile(this.secretPath);
      return encrypted.byteLength > 0;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  public async save(secret: string): Promise<void> {
    if (!this.storage.isEncryptionAvailable()) {
      throw new Error("OS credential encryption is unavailable; the secret was not saved.");
    }

    const encrypted = this.storage.encryptString(secret);
    const temporaryPath = `${this.secretPath}.tmp`;
    await mkdir(dirname(this.secretPath), { recursive: true, mode: 0o700 });
    await writeFile(temporaryPath, encrypted, { mode: 0o600 });
    await rename(temporaryPath, this.secretPath);
  }

  public async read(): Promise<string | undefined> {
    let encrypted: Buffer;
    try {
      encrypted = await readFile(this.secretPath);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }

    if (!this.storage.isEncryptionAvailable()) {
      throw new Error("OS credential encryption is unavailable; the secret cannot be read.");
    }
    return this.storage.decryptString(encrypted);
  }

  public async clear(): Promise<void> {
    try {
      await unlink(this.secretPath);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
