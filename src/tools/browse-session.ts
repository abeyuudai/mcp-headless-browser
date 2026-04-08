import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { chromium } from "playwright";
import type { SessionManager } from "../session-manager.js";
import { KeychainAdapter } from "../keychain-adapter.js";
import { BrowserSessionRegistry } from "../browser-registry.js";
import type { BrowserSession } from "../browser-registry.js";
import {
  USER_AGENT,
  autoFill,
  generateCssSelectorScript,
} from "./_browser-helpers.js";

// Extend BrowserSession with handoff-specific properties
declare module "../browser-registry.js" {
  interface BrowserSession {
    handoffStartedAt?: number;
    handoffCompleted?: boolean;
    handoffReason?: "page_closed" | "disconnected" | null;
    finalUrl?: string;
  }
}

/**
 * Return a session or throw with the standard "not found" message.
 * Also guards against calling other tools during handoff state.
 */
function getActiveSession(
  registry: BrowserSessionRegistry,
  id: string
): BrowserSession {
  const session = registry.get(id); // throws if not found / closed
  if (session.state === "handoff") {
    throw new Error(
      `ブラウザセッション ${id} はユーザー操作待ち中です。browse_handoff で完了を確認してください`
    );
  }
  return session;
}

function makeError(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}

export function registerBrowseSessionTools(
  server: McpServer,
  sessionManager: SessionManager,
  registry: BrowserSessionRegistry
): void {
  const keychain = new KeychainAdapter();

  // ─────────────────────────────────────────────────────
  // 1. browse_open
  // ─────────────────────────────────────────────────────
  server.tool(
    "browse_open",
    "新規ブラウザセッションを開始します。headed Chrome を起動し、URL を開きます。Keychain 自動入力・セッション復元に対応。",
    {
      service: z
        .string()
        .regex(/^[a-z0-9_-]+$/)
        .describe("サービス名（例: rakuten, github）"),
      url: z.string().url().describe("開く URL"),
      auto_login: z
        .boolean()
        .default(true)
        .describe("Keychain に認証情報があれば自動入力する"),
      idle_timeout_minutes: z
        .number()
        .min(1)
        .max(60)
        .default(15)
        .describe("アイドルタイムアウト（分）"),
      load_session: z
        .boolean()
        .default(true)
        .describe("保存済みセッションを読み込む"),
    },
    async ({ service, url, auto_login, idle_timeout_minutes, load_session }) => {
      try {
        const storageState = load_session
          ? await sessionManager.load(service)
          : null;

        const browser = await chromium.launch({ headless: false });
        const context = await browser.newContext({
          ...(storageState ? { storageState: storageState as never } : {}),
          userAgent: USER_AGENT,
          locale: "ja-JP",
        });
        const page = await context.newPage();

        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });

        const autoFillLog: string[] = [];
        if (auto_login) {
          const creds = keychain.getCredentials(service);
          if (creds) {
            await page.waitForTimeout(500);
            const log = await autoFill(page, creds.account, creds.password);
            autoFillLog.push(...log);
          } else {
            autoFillLog.push(
              "Keychain に認証情報なし — 必要なら手動で入力してください"
            );
          }
        }

        const session = registry.create({
          service,
          browser,
          context,
          page,
          autoFillLog,
          idleTimeoutMs: idle_timeout_minutes * 60 * 1000,
        });

        const title = await page.title().catch(() => "");
        const currentUrl = page.url();

        const lines = [
          `browser_id: ${session.id}`,
          `url: ${currentUrl}`,
          `title: ${title}`,
          "",
          "=== auto_fill_log ===",
          ...autoFillLog,
        ];

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return makeError(`browse_open エラー: ${msg}`);
      }
    }
  );

  // ─────────────────────────────────────────────────────
  // 2. browse_inspect
  // ─────────────────────────────────────────────────────
  server.tool(
    "browse_inspect",
    "開いているブラウザのページ内容を検査します。フォーム要素・テキスト・HTML・インタラクティブ要素を取得できます。",
    {
      browser_id: z.string().describe("browse_open で取得した browser_id"),
      mode: z
        .enum(["forms", "text", "html", "interactive"])
        .default("forms")
        .describe(
          "検査モード: forms=フォーム要素, text=テキスト, html=HTML, interactive=操作可能要素"
        ),
      selector: z
        .string()
        .optional()
        .describe("対象を絞るCSSセレクタ（省略時はbody全体）"),
      max_chars: z
        .number()
        .default(20000)
        .describe("返却文字数の上限"),
    },
    async ({ browser_id, mode, selector, max_chars }) => {
      try {
        const session = getActiveSession(registry, browser_id);
        registry.touch(browser_id);

        const page = session.page;
        const url = page.url();
        const title = await page.title().catch(() => "");

        let content = "";

        if (mode === "forms") {
          const cssSelectorScript = generateCssSelectorScript();
          const fields = await page.evaluate(
            ({ script }: { script: string }) => {
              // eslint-disable-next-line no-new-func
              const generateCssSelector = new Function(
                `${script}; return generateCssSelector;`
              )() as (el: Element) => string;

              const elements = Array.from(
                document.querySelectorAll("input, select, textarea, button")
              );
              return elements.map((el) => {
                const input = el as HTMLInputElement;
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                const visible =
                  rect.width > 0 &&
                  rect.height > 0 &&
                  style.display !== "none" &&
                  style.visibility !== "hidden";

                // Label resolution
                let label = "";
                if (input.id) {
                  const labelEl = document.querySelector(
                    `label[for="${CSS.escape(input.id)}"]`
                  );
                  if (labelEl) label = labelEl.textContent?.trim() ?? "";
                }
                if (!label) {
                  const ancestor = el.closest("label");
                  if (ancestor) {
                    const clone = ancestor.cloneNode(true) as HTMLElement;
                    // Remove the input itself from clone to get label text only
                    clone
                      .querySelectorAll("input,select,textarea,button")
                      .forEach((c) => c.remove());
                    label = clone.textContent?.trim() ?? "";
                  }
                }
                if (!label)
                  label = input.getAttribute("aria-label") ?? "";
                if (!label) label = input.placeholder ?? "";

                return {
                  tag: el.tagName.toLowerCase(),
                  type: input.type ?? "",
                  name: input.name ?? "",
                  id: input.id ?? "",
                  placeholder: input.placeholder ?? "",
                  label,
                  css_selector: generateCssSelector(el),
                  visible,
                  required: input.required ?? false,
                };
              });
            },
            { script: cssSelectorScript }
          );

          const lines = fields.map((f) =>
            [
              `[${f.tag}${f.type ? `[type=${f.type}]` : ""}]`,
              `selector: ${f.css_selector}`,
              f.name ? `name: ${f.name}` : null,
              f.id ? `id: ${f.id}` : null,
              f.label ? `label: ${f.label}` : null,
              f.placeholder ? `placeholder: ${f.placeholder}` : null,
              `visible: ${f.visible}`,
              f.required ? "required: true" : null,
            ]
              .filter(Boolean)
              .join(" | ")
          );
          content = lines.join("\n");
        } else if (mode === "text") {
          const scope = selector ?? "body";
          content = await page.evaluate((sel) => {
            const el = document.querySelector(sel) as HTMLElement | null;
            return el?.innerText?.trim() ?? "";
          }, scope);
        } else if (mode === "html") {
          const scope = selector ?? "body";
          const html = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            return el?.outerHTML?.trim() ?? "";
          }, scope);
          content = html.slice(0, max_chars);
        } else if (mode === "interactive") {
          const cssSelectorScript = generateCssSelectorScript();
          const items = await page.evaluate(
            ({ script }: { script: string }) => {
              // eslint-disable-next-line no-new-func
              const generateCssSelector = new Function(
                `${script}; return generateCssSelector;`
              )() as (el: Element) => string;

              const elements = Array.from(
                document.querySelectorAll(
                  'input, select, textarea, button, a[href], [role="button"]'
                )
              );
              return elements.map((el) => {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                const visible =
                  rect.width > 0 &&
                  rect.height > 0 &&
                  style.display !== "none" &&
                  style.visibility !== "hidden";
                const anchor = el as HTMLAnchorElement;
                return {
                  tag: el.tagName.toLowerCase(),
                  css_selector: generateCssSelector(el),
                  text: (el as HTMLElement).innerText?.trim().slice(0, 80) ?? "",
                  href: anchor.href ?? "",
                  visible,
                };
              });
            },
            { script: cssSelectorScript }
          );
          const lines = items.map((i) =>
            [
              `[${i.tag}]`,
              `selector: ${i.css_selector}`,
              i.text ? `text: ${i.text}` : null,
              i.href ? `href: ${i.href}` : null,
              `visible: ${i.visible}`,
            ]
              .filter(Boolean)
              .join(" | ")
          );
          content = lines.join("\n");
        }

        const text = [
          `url: ${url}`,
          `title: ${title}`,
          `mode: ${mode}`,
          "",
          content,
        ]
          .join("\n")
          .slice(0, max_chars);

        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return makeError(`browse_inspect エラー: ${msg}`);
      }
    }
  );

  // ─────────────────────────────────────────────────────
  // 3. browse_fill
  // ─────────────────────────────────────────────────────
  server.tool(
    "browse_fill",
    "ブラウザセッションのフォームにテキストを入力します。Keychain 参照も可能。",
    {
      browser_id: z.string().describe("browse_open で取得した browser_id"),
      fields: z
        .array(
          z.object({
            selector: z.string().describe("入力先の CSS セレクタ"),
            value: z.string().optional().describe("入力する値"),
            keychain: z
              .object({
                service: z.string().describe("Keychain のサービス名"),
                account: z.string().describe("Keychain のアカウント名"),
              })
              .optional()
              .describe("Keychain から値を取得する場合に指定"),
            press_enter: z
              .boolean()
              .optional()
              .describe("入力後に Enter キーを押す"),
          })
        )
        .describe("入力するフィールドのリスト"),
      save_session: z
        .boolean()
        .default(false)
        .describe("入力後にセッションを保存する"),
    },
    async ({ browser_id, fields, save_session }) => {
      try {
        const session = getActiveSession(registry, browser_id);
        registry.touch(browser_id);

        const page = session.page;
        const results: Array<{
          selector: string;
          status: "ok" | "error";
          message?: string;
        }> = [];

        for (const field of fields) {
          try {
            let fillValue: string;
            if (field.keychain) {
              fillValue = keychain.getPasswordByRef(
                field.keychain.service,
                field.keychain.account
              );
            } else if (field.value !== undefined) {
              fillValue = field.value;
            } else {
              throw new Error("value または keychain のいずれかを指定してください");
            }

            await page.fill(field.selector, fillValue);

            if (field.press_enter) {
              await page.press(field.selector, "Enter");
            }

            const logMsg = field.keychain
              ? `[fill] ${field.selector} (keychain: ${field.keychain.service}/${field.keychain.account})`
              : `[fill] ${field.selector}`;
            console.error(logMsg);

            results.push({ selector: field.selector, status: "ok" });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Do not include password values in error messages
            results.push({
              selector: field.selector,
              status: "error",
              message: msg,
            });
          }
        }

        if (save_session) {
          try {
            const state = await session.context.storageState();
            await sessionManager.save(session.service, state);
          } catch {
            // best-effort
          }
        }

        const lines = results.map((r) =>
          r.status === "ok"
            ? `[ok] ${r.selector}`
            : `[error] ${r.selector}: ${r.message}`
        );

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("Target closed") || msg.includes("ターゲットが閉じ")) {
          registry.remove(browser_id);
          return makeError("ブラウザが閉じられました");
        }
        return makeError(`browse_fill エラー: ${msg}`);
      }
    }
  );

  // ─────────────────────────────────────────────────────
  // 4. browse_click
  // ─────────────────────────────────────────────────────
  server.tool(
    "browse_click",
    "ブラウザセッションで要素をクリックします。ナビゲーション待機オプション付き。",
    {
      browser_id: z.string().describe("browse_open で取得した browser_id"),
      selector: z.string().describe("クリックする要素の CSS セレクタ"),
      force: z
        .boolean()
        .default(false)
        .describe("visibility チェックをスキップ（SPA カスタムコンポーネント対応）"),
      wait_for: z
        .enum(["navigation", "networkidle", "none"])
        .default("none")
        .describe("クリック後の待機方法"),
      wait_ms: z
        .number()
        .optional()
        .describe("クリック後に待機するミリ秒数"),
    },
    async ({ browser_id, selector, force, wait_for, wait_ms }) => {
      try {
        const session = getActiveSession(registry, browser_id);
        registry.touch(browser_id);

        const page = session.page;
        const startUrl = page.url();

        if (wait_for === "navigation") {
          await Promise.all([
            page.waitForNavigation({ waitUntil: "domcontentloaded" }),
            page.click(selector, { force }),
          ]);
        } else if (wait_for === "networkidle") {
          await page.click(selector, { force });
          await page.waitForLoadState("networkidle");
        } else {
          await page.click(selector, { force });
        }

        if (wait_ms) {
          await page.waitForTimeout(wait_ms);
        }

        const currentUrl = page.url();
        const title = await page.title().catch(() => "");
        const navigated = currentUrl !== startUrl;

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `url: ${currentUrl}`,
                `title: ${title}`,
                `navigated: ${navigated}`,
              ].join("\n"),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("Target closed") || msg.includes("ターゲットが閉じ")) {
          registry.remove(browser_id);
          return makeError("ブラウザが閉じられました");
        }
        return makeError(`browse_click エラー: ${msg}`);
      }
    }
  );

  // ─────────────────────────────────────────────────────
  // 5. browse_goto
  // ─────────────────────────────────────────────────────
  server.tool(
    "browse_goto",
    "ブラウザセッションで URL に移動します。",
    {
      browser_id: z.string().describe("browse_open で取得した browser_id"),
      url: z.string().url().describe("移動先の URL"),
      wait_until: z
        .enum(["load", "domcontentloaded", "networkidle"])
        .default("domcontentloaded")
        .describe("ページ読み込み完了の基準"),
    },
    async ({ browser_id, url, wait_until }) => {
      try {
        const session = getActiveSession(registry, browser_id);
        registry.touch(browser_id);

        const page = session.page;
        await page.goto(url, { waitUntil: wait_until, timeout: 30000 });

        const currentUrl = page.url();
        const title = await page.title().catch(() => "");

        return {
          content: [
            {
              type: "text" as const,
              text: [`url: ${currentUrl}`, `title: ${title}`].join("\n"),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("Target closed") || msg.includes("ターゲットが閉じ")) {
          registry.remove(browser_id);
          return makeError("ブラウザが閉じられました");
        }
        return makeError(`browse_goto エラー: ${msg}`);
      }
    }
  );

  // ─────────────────────────────────────────────────────
  // 6. browse_handoff  (short-poll 方式)
  // ─────────────────────────────────────────────────────
  server.tool(
    "browse_handoff",
    "ブラウザをユーザーに引き渡して操作を待ちます。ユーザーがブラウザを閉じると完了し、セッションを保存します。MCP タイムアウト対策のため short-poll 方式で動作します。",
    {
      browser_id: z.string().describe("browse_open で取得した browser_id"),
      message: z
        .string()
        .optional()
        .describe("ユーザーへのメッセージ（ログ用）"),
      max_wait_seconds: z
        .number()
        .min(1)
        .max(55)
        .default(50)
        .describe("1回の呼び出しで待機する最大秒数（デフォルト: 50）"),
    },
    async ({ browser_id, message, max_wait_seconds }) => {
      try {
        // get() without getActiveSession so we can access handoff state
        const session = registry.get(browser_id); // throws if not found

        if (message) {
          console.error(`[browse_handoff] ${message}`);
        }

        // Initialize handoff on first call
        if (session.state !== "handoff") {
          registry.setState(browser_id, "handoff");
          session.handoffStartedAt = Date.now();
          session.handoffCompleted = false;
          session.handoffReason = null;

          const page = session.page;
          const browser = session.browser;

          page.once("close", async () => {
            try {
              session.finalUrl = page.url();
            } catch {
              // ignore — page may already be closed
            }
            session.handoffCompleted = true;
            session.handoffReason = "page_closed";
          });

          browser.once("disconnected", () => {
            if (!session.handoffCompleted) {
              session.handoffCompleted = true;
              session.handoffReason =
                session.handoffReason ?? "disconnected";
            }
          });
        }

        // If already completed, save and return
        if (session.handoffCompleted) {
          return await _finishHandoff(session, browser_id);
        }

        // Poll until deadline
        const deadline = Date.now() + max_wait_seconds * 1000;
        while (!session.handoffCompleted && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200));
        }

        if (session.handoffCompleted) {
          return await _finishHandoff(session, browser_id);
        }

        // Still waiting
        const elapsed = Math.floor(
          (Date.now() - (session.handoffStartedAt ?? Date.now())) / 1000
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "waiting",
                elapsed_seconds: elapsed,
              }),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return makeError(`browse_handoff エラー: ${msg}`);
      }
    }
  );

  async function _finishHandoff(session: BrowserSession, browser_id: string) {
    let saved = false;
    try {
      const state = await session.context.storageState();
      await sessionManager.save(session.service, state);
      saved = true;
    } catch {
      // best-effort
    }

    try {
      await session.browser.close();
    } catch {
      // already closed
    }

    registry.remove(browser_id);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            status: "completed",
            reason: session.handoffReason ?? "page_closed",
            final_url: session.finalUrl ?? "",
            session_saved: saved,
          }),
        },
      ],
    };
  }

  // ─────────────────────────────────────────────────────
  // 7. browse_close
  // ─────────────────────────────────────────────────────
  server.tool(
    "browse_close",
    "ブラウザセッションを閉じます。デフォルトでセッションを保存します。",
    {
      browser_id: z.string().describe("browse_open で取得した browser_id"),
      save: z
        .boolean()
        .default(true)
        .describe("閉じる前にセッションを保存する"),
    },
    async ({ browser_id, save }) => {
      try {
        const session = registry.get(browser_id); // allow closing even in handoff state

        let sessionSaved = false;
        if (save) {
          try {
            const state = await session.context.storageState();
            await sessionManager.save(session.service, state);
            sessionSaved = true;
          } catch {
            // best-effort
          }
        }

        try {
          await session.browser.close();
        } catch {
          // already closed
        }

        registry.remove(browser_id);

        return {
          content: [
            {
              type: "text" as const,
              text: `session_saved: ${sessionSaved}`,
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return makeError(`browse_close エラー: ${msg}`);
      }
    }
  );

  // ─────────────────────────────────────────────────────
  // 8. browse_list
  // ─────────────────────────────────────────────────────
  server.tool(
    "browse_list",
    "現在アクティブなブラウザセッションの一覧を返します。",
    {},
    async () => {
      try {
        const sessions = registry.list().map((s) => ({
          browser_id: s.id,
          service: s.service,
          url: (() => {
            try {
              return s.page.url();
            } catch {
              return "";
            }
          })(),
          state: s.state,
          created_at: s.createdAt.toISOString(),
          last_used_at: s.lastUsedAt.toISOString(),
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ sessions }, null, 2),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return makeError(`browse_list エラー: ${msg}`);
      }
    }
  );
}
