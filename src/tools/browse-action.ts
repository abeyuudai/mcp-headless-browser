import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { chromium } from "playwright";
import type { SessionManager } from "../session-manager.js";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const actionSchema = z.object({
  type: z.enum([
    "goto",
    "click",
    "fill",
    "select",
    "wait",
    "extract_text",
    "extract_html",
  ]),
  selector: z.string().optional().describe("CSS セレクタ（click, fill, select, extract_text, extract_html で使用）"),
  value: z.string().optional().describe("入力値（fill の値、select の option value、goto の URL）"),
  wait_ms: z.number().optional().describe("待機時間（ms）。wait アクションで使用（デフォルト: 1000）"),
  force: z.boolean().optional().describe("click で visibility チェックをスキップする（SPA のカスタムコンポーネント対策）"),
});

// Common login page URL patterns
const LOGIN_URL_PATTERNS = [
  /login/i,
  /signin/i,
  /sign-in/i,
  /auth/i,
  /sso/i,
  /cas\/login/i,
];

function detectLoginRedirect(initialUrl: string, currentUrl: string): boolean {
  // Only flag if we were redirected to a different URL that looks like a login page
  if (initialUrl === currentUrl) return false;
  const currentPath = new URL(currentUrl).pathname + new URL(currentUrl).search;
  return LOGIN_URL_PATTERNS.some((pattern) => pattern.test(currentPath));
}

export function registerBrowseAction(
  server: McpServer,
  sessionManager: SessionManager
): void {
  server.tool(
    "browse_action",
    "保存済みセッション（Cookie）を使って認証済みページにアクセスし、操作を実行します。セッション切れの場合はエラーを返します。",
    {
      service: z
        .string()
        .regex(/^[a-z0-9_-]+$/)
        .describe("サービス名（例: rakuten, codmon）"),
      url: z.string().url().describe("アクセスする URL"),
      actions: z
        .array(actionSchema)
        .default([])
        .describe(
          "実行するアクションのリスト。空の場合はページのテキストを取得"
        ),
      wait_seconds: z
        .number()
        .min(0)
        .max(30)
        .default(1)
        .describe("ページ読み込み後の待機秒数（デフォルト: 1）"),
    },
    async ({ service, url, actions, wait_seconds }) => {
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

        // Check for login redirect (session expired)
        if (detectLoginRedirect(url, page.url())) {
          await browser.close();
          return {
            content: [
              {
                type: "text" as const,
                text: `セッション切れ: サービス "${service}" のセッションが期限切れです。browse_login で再ログインしてください。\nリダイレクト先: ${page.url()}`,
              },
            ],
            isError: true,
          };
        }

        // Execute actions
        const results: string[] = [];

        if (actions.length === 0) {
          // Default: extract page text
          const title = await page.title();
          const text = await page.evaluate(() => {
            const removeSelectors = [
              "script",
              "style",
              "noscript",
              "nav",
              "footer",
              "header",
            ];
            for (const sel of removeSelectors) {
              document.querySelectorAll(sel).forEach((el) => el.remove());
            }
            const main =
              document.querySelector("main") ||
              document.querySelector("article") ||
              document.querySelector('[role="main"]');
            const target = main || document.body;
            return target?.innerText?.trim() || "";
          });
          results.push(`Title: ${title}`, `URL: ${page.url()}`, "", text);
        }

        for (const action of actions) {
          switch (action.type) {
            case "goto":
              if (!action.value)
                throw new Error("goto requires value (URL)");
              await page.goto(action.value, {
                waitUntil: "domcontentloaded",
                timeout: 30000,
              });
              // Check login redirect after navigation
              if (detectLoginRedirect(action.value, page.url())) {
                await browser.close();
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: `セッション切れ: サービス "${service}" のセッションが期限切れです。browse_login で再ログインしてください。\nリダイレクト先: ${page.url()}`,
                    },
                  ],
                  isError: true,
                };
              }
              results.push(`[goto] ${page.url()}`);
              break;

            case "click":
              if (!action.selector)
                throw new Error("click requires selector");
              await page.click(action.selector, { force: action.force ?? false });
              results.push(`[click] ${action.selector}`);
              break;

            case "fill":
              if (!action.selector)
                throw new Error("fill requires selector");
              if (action.value === undefined)
                throw new Error("fill requires value");
              await page.fill(action.selector, action.value);
              results.push(`[fill] ${action.selector}`);
              break;

            case "select":
              if (!action.selector)
                throw new Error("select requires selector");
              if (action.value === undefined)
                throw new Error("select requires value");
              await page.selectOption(action.selector, action.value);
              results.push(`[select] ${action.selector} = ${action.value}`);
              break;

            case "wait":
              await page.waitForTimeout(action.wait_ms ?? 1000);
              results.push(`[wait] ${action.wait_ms ?? 1000}ms`);
              break;

            case "extract_text": {
              const selector = action.selector || "body";
              const text = await page.evaluate((sel) => {
                const el = document.querySelector(sel) as HTMLElement | null;
                return el?.innerText?.trim() || "";
              }, selector);
              results.push(text);
              break;
            }

            case "extract_html": {
              const selector = action.selector || "body";
              const html = await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                return el?.innerHTML?.trim() || "";
              }, selector);
              results.push(html);
              break;
            }
          }
        }

        // Update storageState after actions (cookies may have been refreshed)
        const updatedState = await context.storageState();
        await sessionManager.save(service, updatedState);

        await browser.close();

        return {
          content: [{ type: "text" as const, text: results.join("\n") }],
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
              text: `browse_action エラー: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
