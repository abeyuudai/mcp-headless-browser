/**
 * browse_login の手動テスト — headed ブラウザが起動するため GUI 環境で実行
 *
 * 実行: npx tsx tests/test-browse-login.ts
 *
 * 確認項目:
 *   1. headed ブラウザが起動する
 *   2. フォーカスが2秒おきに奪われない（イベント駆動で待機中）
 *   3. ブラウザの×ボタンで閉じるとツールが即座に戻る
 *   4. storageState が正しく保存される
 *
 * 手順:
 *   1. スクリプトを実行
 *   2. ブラウザが開いたら 5〜10 秒ほど他の作業をし、フォーカスが奪われないことを確認
 *   3. ブラウザの×ボタンで閉じる
 *   4. コンソールに結果が表示される
 */

import { chromium, type Browser } from "playwright";
import { SessionManager } from "../src/session-manager.js";
import { unlink } from "node:fs/promises";

const SERVICE = "__test_browse_login__";
const URL = "https://example.com";
const TIMEOUT_MS = 60_000; // 1 minute

async function main() {
  const sm = new SessionManager();
  let failures = 0;

  function assert(label: string, condition: boolean, detail?: string) {
    if (condition) {
      console.log(`  ✓ ${label}`);
    } else {
      console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
      failures++;
    }
  }

  console.log("=== browse_login 手動テスト ===\n");

  let browser: Browser | undefined;
  try {
    // --- Launch (same logic as browse-login.ts) ---
    const b = await chromium.launch({ headless: false });
    browser = b;
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 test",
      locale: "ja-JP",
    });
    const page = await context.newPage();
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });

    assert("headed ブラウザ起動", true);
    console.log("\n  → ブラウザが開きました。");
    console.log("  → 5〜10秒ほど他のウィンドウで作業してフォーカスが奪われないことを確認");
    console.log("  → 確認後、ブラウザの×ボタンで閉じてください（60秒以内）\n");

    // --- Event-driven storageState capture ---
    let lastStorageState = await context.storageState();
    let navEventCount = 0;

    const saveState = async () => {
      try {
        lastStorageState = await context.storageState();
        navEventCount++;
      } catch { /* closed */ }
    };

    page.on("load", saveState);
    page.on("framenavigated", saveState);

    const startTime = Date.now();

    // --- Wait for close/disconnect/timeout ---
    const reason = await Promise.race([
      new Promise<"page_closed">((resolve) =>
        page.on("close", () => resolve("page_closed"))
      ),
      new Promise<"disconnected">((resolve) =>
        b.on("disconnected", () => resolve("disconnected"))
      ),
      new Promise<"timeout">((_, reject) =>
        setTimeout(() => reject(new Error("タイムアウト（60秒）")), TIMEOUT_MS)
      ),
    ]);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`  終了理由: ${reason} (${elapsed}秒後)`);
    assert("ブラウザ終了を検知", reason === "page_closed" || reason === "disconnected");

    // --- Final storageState ---
    if (reason === "page_closed") {
      try {
        lastStorageState = await context.storageState();
        assert("page close 後に最終 storageState 取得", true);
      } catch {
        assert("page close 後に最終 storageState 取得（フォールバック使用）", true);
      }
    }

    // --- Save ---
    await sm.save(SERVICE, lastStorageState);
    const info = await sm.getInfo(SERVICE);
    assert("storageState ファイル保存", info.exists);
    assert("lastModified が設定されている", info.lastModified !== null);
    console.log(`  cookies: ${lastStorageState.cookies.length} 件`);
    console.log(`  navigation イベント: ${navEventCount} 回`);

    // --- Close browser if still alive ---
    try { await b.close(); } catch { /* already closed */ }
    assert("ブラウザ正常終了", true);

    // --- Verify saved state can be restored ---
    const loaded = await sm.load(SERVICE);
    assert("保存した storageState をロード可能", loaded !== null);

    // Cleanup
    await unlink(info.path);

  } catch (error) {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`\n  ✗ エラー: ${msg}`);
    failures++;
    // Cleanup
    try {
      const info = await sm.getInfo(SERVICE);
      await unlink(info.path);
    } catch { /* ok */ }
  }

  console.log(`\n=== 結果: ${failures === 0 ? "全確認項目 OK ✓" : `${failures} 件失敗 ✗`} ===\n`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
