import { randomBytes } from "node:crypto";
import type { Browser, BrowserContext, Page } from "playwright";
import type { SessionManager } from "./session-manager.js";

export type BrowserSessionState = "active" | "handoff" | "closed";

export interface BrowserSession {
  id: string;
  service: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  createdAt: Date;
  lastUsedAt: Date;
  state: BrowserSessionState;
  autoFillLog: string[];
}

export interface CreateOptions {
  service: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  autoFillLog?: string[];
  idleTimeoutMs?: number; // default 15 * 60 * 1000
}

const DEFAULT_MAX_SESSIONS = 3;
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export class BrowserSessionRegistry {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly sessionManager: SessionManager;
  private readonly maxSessions: number;
  private readonly defaultIdleTimeoutMs: number;

  constructor(
    sessionManager: SessionManager,
    options?: { maxSessions?: number; defaultIdleTimeoutMs?: number }
  ) {
    this.sessionManager = sessionManager;
    this.maxSessions = options?.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.defaultIdleTimeoutMs =
      options?.defaultIdleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  create(opts: CreateOptions): BrowserSession {
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(
        `同時セッション数の上限 (${this.maxSessions}) に達しました`
      );
    }

    const hex = randomBytes(3).toString("hex");
    const id = `sess_${opts.service}_${hex}`;
    const now = new Date();

    const session: BrowserSession = {
      id,
      service: opts.service,
      browser: opts.browser,
      context: opts.context,
      page: opts.page,
      createdAt: now,
      lastUsedAt: now,
      state: "active",
      autoFillLog: opts.autoFillLog ?? [],
    };

    this.sessions.set(id, session);

    // disconnected hook
    opts.browser.on("disconnected", () => {
      session.state = "closed";
      this._clearTimer(id);
      this.sessions.delete(id);
    });

    // idle timer
    const timeoutMs = opts.idleTimeoutMs ?? this.defaultIdleTimeoutMs;
    this._startTimer(id, timeoutMs);

    return session;
  }

  get(id: string): BrowserSession {
    const session = this.sessions.get(id);
    if (!session || session.state === "closed") {
      throw new Error(`ブラウザセッションが見つかりません: ${id}`);
    }
    return session;
  }

  remove(id: string): void {
    this._clearTimer(id);
    this.sessions.delete(id);
  }

  touch(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    // no-op if handoff
    if (session.state === "handoff") return;

    session.lastUsedAt = new Date();
    // reset idle timer
    this._clearTimer(id);
    this._startTimer(id, this.defaultIdleTimeoutMs);
  }

  list(): BrowserSession[] {
    return Array.from(this.sessions.values());
  }

  setState(id: string, state: BrowserSessionState): void {
    const session = this.sessions.get(id);
    if (!session) return;

    session.state = state;

    if (state === "handoff") {
      // pause idle timer
      this._clearTimer(id);
    } else if (state === "active") {
      // resume idle timer
      this._startTimer(id, this.defaultIdleTimeoutMs);
    }
  }

  async shutdown(): Promise<void> {
    const closeAll = Promise.all(
      Array.from(this.sessions.values()).map((session) =>
        this._cleanupSession(session)
      )
    );
    await Promise.race([
      closeAll,
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);
  }

  private _startTimer(id: string, timeoutMs: number): void {
    const timer = setTimeout(() => {
      const session = this.sessions.get(id);
      if (session) {
        void this._cleanupSession(session);
      }
    }, timeoutMs);
    this.timers.set(id, timer);
  }

  private _clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  async _cleanupSession(session: BrowserSession): Promise<void> {
    this._clearTimer(session.id);
    // best-effort: save storageState
    try {
      const storageState = await session.context.storageState();
      await this.sessionManager.save(session.service, storageState as never);
    } catch {
      // ignore errors
    }
    // close browser
    try {
      await session.browser.close();
    } catch {
      // ignore errors
    }
    session.state = "closed";
    this.sessions.delete(session.id);
  }
}
