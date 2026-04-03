import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionManager } from "../session-manager.js";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export function registerBrowseScreenshot(
  server: McpServer,
  sessionManager: SessionManager
): void {
  server.tool(
    "browse_screenshot",
    "認証済みセッションを使ってページのスクリーンショットを取得します。画像ファイルのパスを返します。",
    {
      service: z
        .string()
        .regex(/^[a-z0-9_-]+$/)
        .describe("サービス名（例: rakuten, codmon）"),
      url: z.string().url().describe("スクリーンショットを取る URL"),
      wait_seconds: z
        .number()
        .min(0)
        .max(30)
        .default(2)
        .describe("ページ読み込み後の待機秒数（デフォルト: 2）"),
      full_page: z
        .boolean()
        .default(false)
        .describe("ページ全体をキャプチャするか（デフォルト: false = ビューポートのみ）"),
    },
    async ({ service, url, wait_seconds, full_page }) => {
      const storageState = await sessionManager.load(service);
      if (!storageState) {
        return {
          content: [
            {
              type: "text" as const,
              text: `サービス "${service}" のセッションが見つかりません。browse_login で先にログインしてください。`,
            },
          ],
          isError: true,
        };
      }

      let browser;
      try {
        const screenshotsDir = join(
          homedir(),
          ".kurosuke",
          "screenshots"
        );
        await mkdir(screenshotsDir, { recursive: true, mode: 0o700 });

        const timestamp = new Date()
          .toISOString()
          .replace(/[:.]/g, "-")
          .replace("T", "_")
          .replace("Z", "");
        const filename = `${service}_${timestamp}.png`;
        const filePath = join(screenshotsDir, filename);

        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
          storageState: storageState as never,
          userAgent: USER_AGENT,
          locale: "ja-JP",
        });
        const page = await context.newPage();

        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await page.waitForTimeout(wait_seconds * 1000);

        await page.screenshot({ path: filePath, fullPage: full_page });

        await browser.close();

        return {
          content: [
            {
              type: "text" as const,
              text: `スクリーンショットを保存しました: ${filePath}`,
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
              text: `スクリーンショットエラー: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
