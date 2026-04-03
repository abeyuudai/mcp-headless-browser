import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { chromium } from "playwright";
import type { SessionManager } from "../session-manager.js";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const POLL_INTERVAL_MS = 2000;

export function registerBrowseLogin(
  server: McpServer,
  sessionManager: SessionManager
): void {
  server.tool(
    "browse_login",
    "ブラウザを画面付き（headed）で起動し、手動ログインできるようにします。ログイン完了後にブラウザを閉じると、セッション（Cookie）が自動保存されます。2FA や CAPTCHA も手動で対応可能です。GUI 環境が必要です。",
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
    },
    async ({ service, url, timeout_minutes }) => {
      let browser;
      try {
        // Load existing session if available
        const existingState = await sessionManager.load(service);

        browser = await chromium.launch({ headless: false });
        const context = await browser.newContext({
          ...(existingState
            ? { storageState: existingState as never }
            : {}),
          userAgent: USER_AGENT,
          locale: "ja-JP",
        });
        const page = await context.newPage();
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });

        // Poll storageState until browser is closed or timeout
        let lastStorageState = await context.storageState();
        const timeoutMs = timeout_minutes * 60 * 1000;
        const startTime = Date.now();

        while (Date.now() - startTime < timeoutMs) {
          try {
            await page.waitForTimeout(POLL_INTERVAL_MS);
            lastStorageState = await context.storageState();
          } catch {
            // Browser was closed by user
            break;
          }
        }

        // Save the last captured storageState
        await sessionManager.save(service, lastStorageState);

        // Close browser if still open
        try {
          await browser.close();
        } catch {
          /* already closed */
        }

        const info = await sessionManager.getInfo(service);
        const updatedAt = info.lastModified?.toLocaleString("ja-JP", {
          timeZone: "Asia/Tokyo",
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `サービス "${service}" のセッションを保存しました。\n最終更新: ${updatedAt}`,
            },
          ],
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
