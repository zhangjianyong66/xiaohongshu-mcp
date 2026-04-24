import fs from "node:fs/promises";
import path from "node:path";
import { decryptJson, encryptJson } from "./crypto.js";

type StorageState = {
  cookies?: unknown[];
  origins?: unknown[];
};

export class SessionStore {
  public constructor(
    private readonly sessionFile: string,
    private readonly encryptionKey: string
  ) {}

  public async load(): Promise<StorageState | undefined> {
    try {
      const raw = await fs.readFile(this.sessionFile, "utf8");
      return decryptJson<StorageState>(raw, this.encryptionKey);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  public async save(state: StorageState): Promise<void> {
    const dir = path.dirname(this.sessionFile);
    await fs.mkdir(dir, { recursive: true });
    const encrypted = encryptJson(state, this.encryptionKey);
    await fs.writeFile(this.sessionFile, encrypted, "utf8");
  }
}
