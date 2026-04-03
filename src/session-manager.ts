import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SessionInfo {
  service: string;
  exists: boolean;
  lastModified: Date | null;
  path: string;
}

const SERVICE_NAME_PATTERN = /^[a-z0-9_-]+$/;

export class SessionManager {
  private readonly sessionsDir: string;

  constructor() {
    this.sessionsDir = join(homedir(), ".kurosuke", "sessions");
  }

  private validateService(service: string): void {
    if (!SERVICE_NAME_PATTERN.test(service)) {
      throw new Error(
        `Invalid service name: "${service}". Use lowercase alphanumeric, hyphens, and underscores only.`
      );
    }
  }

  private getPath(service: string): string {
    return join(this.sessionsDir, `${service}.json`);
  }

  private async ensureDir(): Promise<void> {
    const kurousukeDir = join(homedir(), ".kurosuke");
    await mkdir(kurousukeDir, { recursive: true, mode: 0o700 });
    await mkdir(this.sessionsDir, { recursive: true, mode: 0o700 });
  }

  async save(service: string, storageState: object): Promise<void> {
    this.validateService(service);
    await this.ensureDir();
    const filePath = this.getPath(service);
    await writeFile(filePath, JSON.stringify(storageState, null, 2), {
      mode: 0o600,
    });
  }

  async load(service: string): Promise<object | null> {
    this.validateService(service);
    try {
      const data = await readFile(this.getPath(service), "utf-8");
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  async exists(service: string): Promise<boolean> {
    this.validateService(service);
    try {
      await stat(this.getPath(service));
      return true;
    } catch {
      return false;
    }
  }

  async getInfo(service: string): Promise<SessionInfo> {
    this.validateService(service);
    const path = this.getPath(service);
    try {
      const s = await stat(path);
      return { service, exists: true, lastModified: s.mtime, path };
    } catch {
      return { service, exists: false, lastModified: null, path };
    }
  }

  async listAll(): Promise<SessionInfo[]> {
    try {
      const files = await readdir(this.sessionsDir);
      const sessions = files
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""));
      return Promise.all(sessions.map((s) => this.getInfo(s)));
    } catch {
      return [];
    }
  }
}
