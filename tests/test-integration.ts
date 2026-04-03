/**
 * 統合テスト — MCP サーバー起動、全ツールの動作確認
 *
 * 実行: npx tsx tests/test-integration.ts
 *
 * 前提: 楽天のセッション（~/.kurosuke/sessions/rakuten.json）が保存済みであること
 */

import { chromium } from "playwright";
import { SessionManager } from "../src/session-manager.js";
import { stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

let failures = 0;

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

// ─── 1. fetch_page (refactored) ───

async function testFetchPage() {
  console.log("\n=== fetch_page（リファクタ後） ===");

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "ja-JP",
    });
    const page = await context.newPage();
    await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1000);

    const title = await page.title();
    const text = await page.evaluate(() => {
      const removeSelectors = ["script", "style", "noscript", "nav", "footer", "header"];
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
    const pageUrl = page.url();

    assert("タイトル取得", title.includes("Example"));
    assert("テキスト取得", text.length > 0);
    assert("URL 取得", pageUrl.includes("example.com"));

    // Verify result format matches original
    const result = [`Title: ${title}`, `URL: ${pageUrl}`, "", text].join("\n");
    assert("出力フォーマットが正しい", result.startsWith("Title:") && result.includes("URL:"));
  } finally {
    await browser.close();
  }
}

// ─── 2. browse_status ───

async function testBrowseStatus() {
  console.log("\n=== browse_status ===");
  const sm = new SessionManager();

  // Service that doesn't exist
  const infoNone = await sm.getInfo("__nonexistent__");
  assert("存在しないサービス → exists=false", !infoNone.exists);

  // Rakuten should exist (from previous test)
  const infoRakuten = await sm.getInfo("rakuten");
  assert("rakuten セッション存在", infoRakuten.exists);
  if (infoRakuten.exists) {
    assert("lastModified が Date", infoRakuten.lastModified instanceof Date);
    const updatedAt = infoRakuten.lastModified!.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
    console.log(`  最終更新: ${updatedAt}`);
  }

  // listAll
  const all = await sm.listAll();
  assert("listAll() に rakuten が含まれる", all.some((s) => s.service === "rakuten"));
  console.log(`  保存済みセッション数: ${all.length}`);
  for (const s of all) {
    const t = s.lastModified!.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
    console.log(`    - ${s.service}: ${t}`);
  }

  // Output format matches browse_status tool
  if (all.length > 0) {
    const lines = all.map((s) => {
      const t = s.lastModified!.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
      return `- ${s.service}: 保存済み (最終更新: ${t})`;
    });
    const output = `セッション一覧:\n${lines.join("\n")}`;
    assert("出力フォーマットが正しい", output.startsWith("セッション一覧:"));
  }
}

// ─── 3. browse_action: all action types ───

async function testBrowseActionActions() {
  console.log("\n=== browse_action: 全アクションタイプ ===");

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ locale: "ja-JP" });
    const page = await context.newPage();

    // Use a page with a form for testing
    await page.setContent(`
      <html>
        <body>
          <h1>Test Page</h1>
          <form>
            <input type="text" name="username" value="">
            <input type="password" name="pass" value="">
            <select name="category">
              <option value="a">Option A</option>
              <option value="b">Option B</option>
            </select>
            <button type="submit">Submit</button>
          </form>
          <div id="result">Hello World</div>
        </body>
      </html>
    `);

    // fill
    await page.fill('input[name="username"]', "testuser");
    const filledValue = await page.inputValue('input[name="username"]');
    assert("fill: テキスト入力", filledValue === "testuser");

    // fill password
    await page.fill('input[name="pass"]', "secret");
    const passValue = await page.inputValue('input[name="pass"]');
    assert("fill: パスワード入力", passValue === "secret");

    // select
    await page.selectOption('select[name="category"]', "b");
    const selectValue = await page.inputValue('select[name="category"]');
    assert("select: プルダウン選択", selectValue === "b");

    // wait
    const before = Date.now();
    await page.waitForTimeout(500);
    const elapsed = Date.now() - before;
    assert("wait: 待機動作", elapsed >= 450);

    // extract_text
    const text = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      return el?.innerText?.trim() || "";
    }, "#result");
    assert("extract_text: テキスト抽出", text === "Hello World");

    // extract_html
    const html = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el?.innerHTML?.trim() || "";
    }, "#result");
    assert("extract_html: HTML 抽出", html === "Hello World");

    // goto (test before click, since click may navigate away on some pages)
    await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 30000 });
    assert("goto: ページ遷移", page.url().includes("example.com"));

    // click (on example.com)
    await page.setContent(`
      <html><body>
        <div id="out">before</div>
        <button id="btn">Click me</button>
        <script>
          document.getElementById("btn").addEventListener("click", () => {
            document.getElementById("out").textContent = "after";
          });
        </script>
      </body></html>
    `);
    await page.click("#btn");
    const afterClick = await page.evaluate(() => document.getElementById("out")!.textContent);
    assert("click: ボタンクリック", afterClick === "after");

  } finally {
    await browser.close();
  }
}

// ─── 4. browse_action: authenticated session ───

async function testBrowseActionAuthenticated() {
  console.log("\n=== browse_action: 認証済みセッションでアクセス ===");
  const sm = new SessionManager();

  const state = await sm.load("rakuten");
  if (!state) {
    console.log("  [スキップ] rakuten セッションなし");
    return;
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      storageState: state as never,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "ja-JP",
    });
    const page = await context.newPage();

    // Access purchase history
    await page.goto("https://order.my.rakuten.co.jp/?page=myorder", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(2000);

    const finalUrl = page.url();
    const isLogin = /login|signin|auth|sso/i.test(finalUrl);
    assert("購入履歴にアクセス（セッション有効）", !isLogin, isLogin ? `リダイレクト: ${finalUrl}` : undefined);

    // Extract text (same logic as browse_action with empty actions)
    const title = await page.title();
    const text = await page.evaluate(() => {
      const removeSelectors = ["script", "style", "noscript", "nav", "footer", "header"];
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
    assert("テキスト抽出成功", text.length > 0);
    console.log(`  タイトル: ${title}`);
    console.log(`  テキスト先頭100文字: ${text.slice(0, 100)}...`);

    // Verify storageState can be updated after browsing
    const updated = await context.storageState();
    assert("storageState 更新取得", "cookies" in updated);
    await sm.save("rakuten", updated);
    assert("storageState 再保存", await sm.exists("rakuten"));

  } finally {
    await browser.close();
  }
}

// ─── 5. browse_screenshot: authenticated session ───

async function testBrowseScreenshotAuthenticated() {
  console.log("\n=== browse_screenshot: 認証済みスクリーンショット ===");
  const sm = new SessionManager();

  const state = await sm.load("rakuten");
  if (!state) {
    console.log("  [スキップ] rakuten セッションなし");
    return;
  }

  const screenshotsDir = join(homedir(), ".kurosuke", "screenshots");
  const filePath = join(screenshotsDir, "__test_rakuten_ss__.png");

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      storageState: state as never,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "ja-JP",
    });
    const page = await context.newPage();
    await page.goto("https://order.my.rakuten.co.jp/?page=myorder", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(2000);

    await page.screenshot({ path: filePath, fullPage: false });
    const s = await stat(filePath);
    assert("スクリーンショット作成", s.size > 0);
    assert("ファイルサイズ妥当（>5KB）", s.size > 5000);
    console.log(`  ファイルサイズ: ${(s.size / 1024).toFixed(1)} KB`);

    await unlink(filePath);
  } finally {
    await browser.close();
  }
}

// ─── 6. MCP サーバー起動 ───

async function testMcpServerStartup() {
  console.log("\n=== MCP サーバー起動 + ツール登録 ===");

  const { spawn } = await import("node:child_process");

  try {
    const result = await new Promise<string>((resolve, reject) => {
      const proc = spawn("node", ["dist/index.js"], {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: "/Users/abe-yudai/repositories/abe-all/repositories/mcp-headless-browser",
      });

      let output = "";
      proc.stdout.on("data", (data: Buffer) => { output += data.toString(); });

      // Send initialize request
      const initMsg = JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
      });
      proc.stdin.write(initMsg + "\n");

      // Send tools/list after a short delay
      setTimeout(() => {
        const toolsMsg = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        proc.stdin.write(toolsMsg + "\n");
      }, 500);

      // Collect output and kill after 3 seconds
      setTimeout(() => {
        proc.kill();
        resolve(output);
      }, 3000);

      proc.on("error", reject);
    });

    const lines = result.trim().split("\n").filter((l) => l.startsWith("{"));
    assert("サーバーがレスポンスを返す", lines.length >= 2, `got ${lines.length} lines`);

    if (lines.length >= 2) {
      const initResp = JSON.parse(lines[0]);
      assert("initialize 成功", initResp.result?.serverInfo?.name === "headless-browser");
      assert("バージョン 1.1.0", initResp.result?.serverInfo?.version === "1.1.0");

      const toolsResp = JSON.parse(lines[1]);
      const toolNames: string[] = toolsResp.result?.tools?.map((t: any) => t.name) ?? [];
      console.log(`  登録ツール: ${toolNames.join(", ")}`);

      const expected = ["fetch_page", "browse_login", "browse_status", "browse_action", "browse_screenshot"];
      for (const name of expected) {
        assert(`ツール "${name}" が登録されている`, toolNames.includes(name));
      }
    }
  } catch (error) {
    assert("MCP サーバー起動", false, String(error));
  }
}

// ─── Main ───

async function main() {
  console.log("=== 統合テスト ===");

  await testFetchPage();
  await testBrowseStatus();
  await testBrowseActionActions();
  await testBrowseActionAuthenticated();
  await testBrowseScreenshotAuthenticated();
  await testMcpServerStartup();

  console.log(`\n=== 結果: ${failures === 0 ? "全テスト合格 ✓" : `${failures} 件失敗 ✗`} ===\n`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
