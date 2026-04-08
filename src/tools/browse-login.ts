import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { chromium, type Browser, type Page } from "playwright";
import type { SessionManager } from "../session-manager.js";
import { KeychainAdapter } from "../keychain-adapter.js";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Common username/password selectors (tried in order)
const DEFAULT_USERNAME_SELECTORS = [
  'input[type="email"]',
  'input[name="email"]',
  'input[name="username"]',
  'input[name="user"]',
  'input[name="login"]',
  'input[name="loginEmail"]',
  'input[name="u"]',
  'input[name="id"]',
  'input[type="text"]',
];

const DEFAULT_PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name="password"]',
  'input[name="pass"]',
  'input[name="passwd"]',
];

async function autoFill(
  page: Page,
  account: string,
  password: string,
  usernameSelector?: string,
  passwordSelector?: string
): Promise<string[]> {
  const log: string[] = [];

  // Username
  const userSelectors = usernameSelector
    ? [usernameSelector]
    : DEFAULT_USERNAME_SELECTORS;

  let filled = false;
  for (const sel of userSelectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        await el.fill(account);
        log.push(`ユーザー名を入力 (${sel})`);
        filled = true;
        break;
      }
    } catch {
      // Selector not found or not fillable
    }
  }
  if (!filled) {
    log.push("ユーザー名フィールドが見つかりません — 手動で入力してください");
  }

  // Password
  const passSelectors = passwordSelector
    ? [passwordSelector]
    : DEFAULT_PASSWORD_SELECTORS;

  filled = false;
  for (const sel of passSelectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        await el.fill(password);
        log.push(`パスワードを入力 (${sel})`);
        filled = true;
        break;
      }
    } catch {
      // Selector not found or not fillable
    }
  }
  if (!filled) {
    log.push("パスワードフィールドが見つかりません — 手動で入力してください");
  }

  return log;
}

export function registerBrowseLogin(
  server: McpServer,
  sessionManager: SessionManager
): void {
  const keychain = new KeychainAdapter();

  server.tool(
    "browse_login",
    "ブラウザを画面付き（headed）で起動しログインします。Keychain に認証情報があれば自動入力します（2FA/CAPTCHA は手動）。ログイン完了後にブラウザを閉じるとセッションが保存されます。GUI 環境が必要です。",
    {
      service: z
        .string()
        .regex(/^[a-z0-9_-]+$/)
        .describe("サービス名（例: rakuten, codmon）"),
      url: z.string().url().describe("ログインページの URL"),
      timeout_minutes: z
        .number()
        .min(1)
        .max(30)
        .default(5)
        .describe("手動ログインのタイムアウト（分、デフォルト: 5）"),
      username_selector: z
        .string()
        .optional()
        .describe("ユーザー名フィールドの CSS セレクタ（省略時は汎用セレクタで自動検出）"),
      password_selector: z
        .string()
        .optional()
        .describe("パスワードフィールドの CSS セレクタ（省略時は汎用セレクタで自動検出）"),
    },
    async ({ service, url, timeout_minutes, username_selector, password_selector }) => {
      let browser: Browser | undefined;
      try {
        const existingState = await sessionManager.load(service);

        const b = await chromium.launch({ headless: false });
        browser = b;
        const context = await browser.newContext({
          ...(existingState
            ? { storageState: existingState as never }
            : {}),
          userAgent: USER_AGENT,
          locale: "ja-JP",
        });
        // NOTE: popup auto-close disabled — it was killing SSO redirect pages
        // context.on("page", (popup) => {
        //   popup.close().catch(() => {});
        // });

        const page = await context.newPage();
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });

        // Auto-fill from Keychain if credentials exist
        const autoFillLog: string[] = [];
        const creds = keychain.getCredentials(service);
        if (creds) {
          await page.waitForTimeout(500); // Wait for form to render
          const log = await autoFill(page, creds.account, creds.password, username_selector, password_selector);
          autoFillLog.push(...log);
        } else {
          autoFillLog.push("Keychain に認証情報なし — 手動で入力してください");
        }

        // Event-driven: save storageState on main frame navigation only
        // (iframe navigations are ignored — ad iframes like Criteo/DoubleClick
        // can fire 100+ framenavigated events and overwhelm the browser)
        let lastStorageState = await context.storageState();
        let saving = false;

        const saveState = async () => {
          if (saving) return;
          saving = true;
          try {
            lastStorageState = await context.storageState();
          } catch {
            // Browser/context already closed
          } finally {
            saving = false;
          }
        };

        page.on("load", saveState);
        page.on("framenavigated", (frame) => {
          if (frame === page.mainFrame()) {
            saveState();
          }
        });

        const timeoutMs = timeout_minutes * 60 * 1000;

        // Wait for: page close (user closes tab/window), browser disconnect, or timeout
        const reason = await Promise.race([
          new Promise<"page_closed">((resolve) =>
            page.on("close", () => resolve("page_closed"))
          ),
          new Promise<"disconnected">((resolve) =>
            b.on("disconnected", () => resolve("disconnected"))
          ),
          new Promise<"timeout">((_, reject) =>
            setTimeout(() => reject(new Error("ログインがタイムアウトしました")), timeoutMs)
          ),
        ]);

        // On page close, browser is still alive — get final storageState
        if (reason === "page_closed") {
          try {
            lastStorageState = await context.storageState();
          } catch {
            // Context already gone
          }
        }

        await sessionManager.save(service, lastStorageState);

        try {
          await browser.close();
        } catch {
          /* already closed */
        }

        const info = await sessionManager.getInfo(service);
        const updatedAt = info.lastModified?.toLocaleString("ja-JP", {
          timeZone: "Asia/Tokyo",
        });

        const message = [
          `サービス "${service}" のセッションを保存しました。`,
          `最終更新: ${updatedAt}`,
          "",
          ...autoFillLog,
        ].join("\n");

        return {
          content: [{ type: "text" as const, text: message }],
        };
      } catch (error) {
        try {
          if (browser) await browser.close();
        } catch {
          /* ignore */
        }
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: `ログインエラー: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
