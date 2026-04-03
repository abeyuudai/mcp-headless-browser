/**
 * 楽天ログインの実機テスト
 *
 * 実行: npx tsx tests/test-rakuten-login.ts
 *
 * 確認項目:
 *   1. Keychain から認証情報を取得できる
 *   2. ログインフォームに自動入力される
 *   3. ログイン完了後にブラウザを閉じると storageState が保存される
 *   4. 保存した storageState で購入履歴ページにアクセスできる（セッション有効）
 */

import { chromium, type Browser, type Page } from "playwright";
import { SessionManager } from "../src/session-manager.js";
import { KeychainAdapter } from "../src/keychain-adapter.js";
import { unlink } from "node:fs/promises";

const SERVICE = "rakuten";
const LOGIN_URL = "https://grp02.id.rakuten.co.jp/rms/nid/vc?__event=login&service_id=top";
const HISTORY_URL = "https://order.my.rakuten.co.jp/?page=myorder";
const TIMEOUT_MS = 120_000; // 2 minutes

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

let failures = 0;

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

async function autoFill(page: Page, account: string, password: string): Promise<string[]> {
  const log: string[] = [];

  let filled = false;
  for (const sel of DEFAULT_USERNAME_SELECTORS) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        await el.fill(account);
        log.push(`ユーザー名を入力 (${sel})`);
        filled = true;
        break;
      }
    } catch { /* skip */ }
  }
  if (!filled) log.push("ユーザー名フィールド未検出");

  filled = false;
  for (const sel of DEFAULT_PASSWORD_SELECTORS) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        await el.fill(password);
        log.push(`パスワードを入力 (${sel})`);
        filled = true;
        break;
      }
    } catch { /* skip */ }
  }
  if (!filled) log.push("パスワードフィールド未検出");

  return log;
}

async function main() {
  const sm = new SessionManager();
  const kc = new KeychainAdapter();

  console.log("=== 楽天ログイン 実機テスト ===\n");

  // Step 1: Keychain
  const creds = kc.getCredentials(SERVICE);
  assert("Keychain から認証情報を取得", creds !== null);
  if (!creds) {
    console.log("\n  Keychain に kurosuke.rakuten が未登録です。先に登録してください。");
    process.exit(1);
  }
  console.log(`  アカウント: ${creds.account}\n`);

  // Step 2: Login
  let browser: Browser | undefined;
  try {
    const b = await chromium.launch({ headless: false });
    browser = b;
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "ja-JP",
    });
    const page = await context.newPage();
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    assert("ログインページを開いた", true);

    // Auto-fill
    await page.waitForTimeout(500);
    const fillLog = await autoFill(page, creds.account, creds.password);
    for (const line of fillLog) console.log(`  → ${line}`);

    const userFilled = fillLog.some((l) => l.includes("ユーザー名を入力"));
    const passFilled = fillLog.some((l) => l.includes("パスワードを入力"));
    assert("ユーザー名の自動入力", userFilled);
    assert("パスワードの自動入力", passFilled);

    console.log("\n  → ログインボタンを押してログインを完了してください");
    console.log("  → 2FA があれば手動で対応してください");
    console.log("  → ログイン完了後、ブラウザを閉じてください（2分以内）\n");

    // Close popup tabs immediately and log them
    let popupCount = 0;
    context.on("page", (newPage) => {
      popupCount++;
      console.log(`  [ポップアップ #${popupCount} → 閉じました] ${newPage.url()}`);
      newPage.close().catch(() => {});
    });

    // Event-driven wait (main frame only — iframe ad networks fire 100+ events)
    let lastStorageState = await context.storageState();
    let saving = false;
    const saveState = async () => {
      if (saving) return;
      saving = true;
      try { lastStorageState = await context.storageState(); } catch { /* closed */ }
      finally { saving = false; }
    };
    page.on("load", saveState);
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) saveState();
    });

    const reason = await Promise.race([
      new Promise<"page_closed">((resolve) => page.on("close", () => resolve("page_closed"))),
      new Promise<"disconnected">((resolve) => b.on("disconnected", () => resolve("disconnected"))),
      new Promise<"timeout">((_, reject) => setTimeout(() => reject(new Error("タイムアウト")), TIMEOUT_MS)),
    ]);

    if (reason === "page_closed") {
      try { lastStorageState = await context.storageState(); } catch { /* gone */ }
    }

    await sm.save(SERVICE, lastStorageState);
    assert("storageState 保存成功", await sm.exists(SERVICE));

    const cookieCount = lastStorageState.cookies.length;
    console.log(`  cookies: ${cookieCount} 件`);
    assert("Cookie が取得できている", cookieCount > 0);

    try { await b.close(); } catch { /* already closed */ }

  } catch (error) {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    assert("ログインフロー", false, String(error));
    console.log(`\n=== 結果: ${failures} 件失敗 ✗ ===\n`);
    process.exit(1);
  }

  // Step 3: Verify session works
  console.log("\n--- セッション検証: 購入履歴ページにアクセス ---\n");

  const savedState = await sm.load(SERVICE);
  assert("保存済み storageState をロード", savedState !== null);

  let verifyBrowser: Browser | undefined;
  try {
    verifyBrowser = await chromium.launch({ headless: true });
    const ctx = await verifyBrowser.newContext({
      storageState: savedState as never,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "ja-JP",
    });
    const page = await ctx.newPage();
    await page.goto(HISTORY_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);

    const finalUrl = page.url();
    const isLogin = /login|signin|auth|sso/i.test(finalUrl);
    assert("購入履歴ページにアクセス（リダイレクトなし）", !isLogin, isLogin ? `リダイレクト先: ${finalUrl}` : undefined);

    if (!isLogin) {
      const title = await page.title();
      console.log(`  ページタイトル: ${title}`);
      console.log(`  URL: ${finalUrl}`);
      assert("ページタイトルが取得できる", title.length > 0);
    }

    await verifyBrowser.close();
  } catch (error) {
    try { if (verifyBrowser) await verifyBrowser.close(); } catch { /* ignore */ }
    assert("セッション検証", false, String(error));
  }

  console.log(`\n=== 結果: ${failures === 0 ? "全テスト合格 ✓" : `${failures} 件失敗 ✗`} ===\n`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
