/**
 * ヘッドレスブラウザテスト — ブラウザ起動するが GUI 不要
 *
 * 実行: npx tsx tests/test-headless.ts
 */

import { chromium } from "playwright";
import { SessionManager } from "../src/session-manager.js";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { stat, mkdir } from "node:fs/promises";

let failures = 0;

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

async function testBrowseActionFlow() {
  console.log("\n=== browse_action フロー ===");
  const sm = new SessionManager();
  const svc = "__test_action__";
  const emptyState = { cookies: [], origins: [] };
  await sm.save(svc, emptyState);

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      storageState: emptyState as never,
      userAgent: "Mozilla/5.0 test",
      locale: "ja-JP",
    });
    const page = await context.newPage();

    // Navigate
    await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1000);

    const title = await page.title();
    assert("ページ取得成功", title.includes("Example"));

    // extract_text
    const text = await page.evaluate(() => {
      const el = document.querySelector("body") as HTMLElement | null;
      return el?.innerText?.trim() || "";
    });
    assert("テキスト抽出成功", text.length > 0);
    assert("テキストに内容あり", text.includes("Example"));

    // extract_html
    const html = await page.evaluate(() => {
      const el = document.querySelector("h1");
      return el?.innerHTML?.trim() || "";
    });
    assert("HTML 抽出成功", html.length > 0);

    // storageState update
    const updated = await context.storageState();
    assert("storageState 取得成功", "cookies" in updated && "origins" in updated);
    await sm.save(svc, updated);
    assert("storageState 保存成功", await sm.exists(svc));

    // click (test on example.com's link)
    const linkExists = await page.evaluate(() => !!document.querySelector("a"));
    if (linkExists) {
      await page.click("a");
      await page.waitForTimeout(1000);
      assert("click アクション成功", true);
    } else {
      assert("click アクション（リンクなし、スキップ）", true);
    }

  } finally {
    await browser.close();
    const info = await sm.getInfo(svc);
    try { await unlink(info.path); } catch { /* ok */ }
  }
}

async function testScreenshotFlow() {
  console.log("\n=== browse_screenshot フロー ===");
  const sm = new SessionManager();
  const svc = "__test_ss__";
  const emptyState = { cookies: [], origins: [] };
  await sm.save(svc, emptyState);

  const screenshotsDir = join(homedir(), ".kurosuke", "screenshots");
  await mkdir(screenshotsDir, { recursive: true, mode: 0o700 });
  const filePath = join(screenshotsDir, "__test_screenshot__.png");

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      storageState: emptyState as never,
      locale: "ja-JP",
    });
    const page = await context.newPage();
    await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1000);

    // Viewport screenshot
    await page.screenshot({ path: filePath, fullPage: false });
    const s1 = await stat(filePath);
    assert("スクリーンショット作成", s1.size > 0);
    assert("ファイルサイズ妥当（>1KB）", s1.size > 1000);
    await unlink(filePath);

    // Full page screenshot
    await page.screenshot({ path: filePath, fullPage: true });
    const s2 = await stat(filePath);
    assert("フルページスクリーンショット作成", s2.size > 0);
    assert("フルページ ≥ ビューポート", s2.size >= s1.size);
    await unlink(filePath);

  } finally {
    await browser.close();
    const info = await sm.getInfo(svc);
    try { await unlink(info.path); } catch { /* ok */ }
  }
}

async function testSessionExpiredFlow() {
  console.log("\n=== セッション切れフロー ===");
  const sm = new SessionManager();
  const svc = "__test_expired__";

  // No session saved
  const state = await sm.load(svc);
  assert("セッションなし → null", state === null);

  // Simulate: saved session but page redirects to login
  const emptyState = { cookies: [], origins: [] };
  await sm.save(svc, emptyState);

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      storageState: emptyState as never,
      locale: "ja-JP",
    });
    const page = await context.newPage();

    // Access a URL that doesn't redirect (example.com)
    await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 30000 });
    const url = page.url();
    assert("リダイレクトなし → URL 一致", url.includes("example.com"));

  } finally {
    await browser.close();
    const info = await sm.getInfo(svc);
    try { await unlink(info.path); } catch { /* ok */ }
  }
}

async function testStorageStateWithContext() {
  console.log("\n=== storageState のコンテキスト間受け渡し ===");
  const sm = new SessionManager();
  const svc = "__test_ctx__";

  const browser = await chromium.launch({ headless: true });
  try {
    // Context 1: visit page, get cookies
    const ctx1 = await browser.newContext({ locale: "ja-JP" });
    const page1 = await ctx1.newPage();
    await page1.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 30000 });

    // Add a cookie manually for testing
    await ctx1.addCookies([{
      name: "test_session",
      value: "abc123",
      domain: ".example.com",
      path: "/",
    }]);

    const state1 = await ctx1.storageState();
    assert("Cookie 追加成功", state1.cookies.length > 0);
    await sm.save(svc, state1);
    await ctx1.close();

    // Context 2: restore from saved state
    const loaded = await sm.load(svc);
    assert("storageState ロード成功", loaded !== null);

    const ctx2 = await browser.newContext({
      storageState: loaded as never,
      locale: "ja-JP",
    });
    const state2 = await ctx2.storageState();
    assert("復元後の Cookie 数が一致", state2.cookies.length === state1.cookies.length);

    const testCookie = state2.cookies.find((c) => c.name === "test_session");
    assert("Cookie 値が保持されている", testCookie?.value === "abc123");
    await ctx2.close();

  } finally {
    await browser.close();
    const info = await sm.getInfo(svc);
    try { await unlink(info.path); } catch { /* ok */ }
  }
}

async function main() {
  console.log("=== ヘッドレスブラウザテスト ===");
  await testBrowseActionFlow();
  await testScreenshotFlow();
  await testSessionExpiredFlow();
  await testStorageStateWithContext();

  console.log(`\n=== 結果: ${failures === 0 ? "全テスト合格 ✓" : `${failures} 件失敗 ✗`} ===\n`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
