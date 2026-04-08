/**
 * ユニットテスト — ブラウザ不要、即座に実行可能
 *
 * 実行: npx tsx tests/test-unit.ts
 */

import { SessionManager } from "../src/session-manager.js";
import { KeychainAdapter } from "../src/keychain-adapter.js";
import { execSync } from "node:child_process";
import { unlink } from "node:fs/promises";

let failures = 0;

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

async function testSessionManager() {
  console.log("\n=== SessionManager ===");
  const sm = new SessionManager();
  const svc = "__test_unit__";

  // Clean state
  assert("exists() → false for unknown", !(await sm.exists(svc)));
  const info1 = await sm.getInfo(svc);
  assert("getInfo() → exists=false", !info1.exists);
  assert("getInfo() → lastModified=null", info1.lastModified === null);
  assert("load() → null for unknown", (await sm.load(svc)) === null);

  // Save & load
  const fakeState = { cookies: [{ name: "sid", value: "abc" }], origins: [] };
  await sm.save(svc, fakeState);
  assert("save() succeeds", true);
  assert("exists() → true after save", await sm.exists(svc));
  const loaded = await sm.load(svc);
  assert("load() → matches saved data", JSON.stringify(loaded) === JSON.stringify(fakeState));

  // getInfo
  const info2 = await sm.getInfo(svc);
  assert("getInfo() → exists=true", info2.exists);
  assert("getInfo() → lastModified is Date", info2.lastModified instanceof Date);

  // listAll
  const all = await sm.listAll();
  assert("listAll() includes service", all.some((s) => s.service === svc));

  // Overwrite
  const newState = { cookies: [{ name: "sid", value: "xyz" }], origins: [{ origin: "https://example.com", localStorage: [] }] };
  await sm.save(svc, newState);
  const reloaded = await sm.load(svc);
  assert("overwrite → new data", JSON.stringify(reloaded) === JSON.stringify(newState));

  // Cleanup
  await unlink(info2.path);
  assert("cleanup done", !(await sm.exists(svc)));

  // Validation: path traversal
  for (const bad of ["../evil", "a/b", "A_UPPER", "has space", ""]) {
    let threw = false;
    try { await sm.exists(bad); } catch { threw = true; }
    assert(`rejects invalid name "${bad}"`, threw);
  }

  // Valid names
  for (const good of ["rakuten", "cod-mon", "service_1", "a"]) {
    let threw = false;
    try { await sm.exists(good); } catch { threw = true; }
    assert(`accepts valid name "${good}"`, !threw);
  }
}

async function testKeychainAdapter() {
  console.log("\n=== KeychainAdapter ===");
  const kc = new KeychainAdapter();
  const svc = "__test_kc_unit__";

  // Non-existent
  assert("getCredentials() → null for unknown", kc.getCredentials(svc) === null);
  assert("hasCredentials() → false for unknown", !kc.hasCredentials(svc));

  // Set & get
  try {
    kc.setCredentials(svc, "user@test.com", "p@ss w0rd!\"'\\");
    assert("setCredentials() succeeds", true);

    const creds = kc.getCredentials(svc);
    assert("getCredentials() returns account", creds?.account === "user@test.com");
    assert("getCredentials() returns password with special chars", creds?.password === "p@ss w0rd!\"'\\");
    assert("hasCredentials() → true", kc.hasCredentials(svc));

    // Update
    kc.setCredentials(svc, "new@test.com", "newpass");
    const updated = kc.getCredentials(svc);
    assert("update overwrites account", updated?.account === "new@test.com");
    assert("update overwrites password", updated?.password === "newpass");
  } finally {
    // Cleanup
    try {
      const { execSync } = await import("node:child_process");
      execSync(`security delete-generic-password -s "kurosuke.${svc}" 2>/dev/null`);
    } catch { /* ok */ }
  }
}

async function testKeychainGetPasswordByRef() {
  console.log("\n=== KeychainAdapter.getPasswordByRef ===");
  const kc = new KeychainAdapter();
  const svc = "__test_kc_ref__";
  const acct = "test-ref-user";

  try {
    execSync(`security add-generic-password -s "${svc}" -a "${acct}" -w "secret123"`);
    const password = kc.getPasswordByRef(svc, acct);
    assert("returns correct password", password === "secret123");

    // Unknown account should throw
    let threw = false;
    try { kc.getPasswordByRef(svc, "nonexistent"); } catch { threw = true; }
    assert("throws for unknown account", threw);

    // Unknown service should throw
    threw = false;
    try { kc.getPasswordByRef("__no_such_svc__", acct); } catch { threw = true; }
    assert("throws for unknown service", threw);
  } finally {
    try { execSync(`security delete-generic-password -s "${svc}" -a "${acct}" 2>/dev/null`); } catch { /* ok */ }
  }
}

async function testLoginRedirectDetection() {
  console.log("\n=== セッション切れ検出 ===");

  // Same logic as browse-action.ts
  const LOGIN_URL_PATTERNS = [
    /login/i, /signin/i, /sign-in/i, /auth/i, /sso/i, /cas\/login/i,
  ];

  function detect(initial: string, current: string): boolean {
    if (initial === current) return false;
    const path = new URL(current).pathname + new URL(current).search;
    return LOGIN_URL_PATTERNS.some((p) => p.test(path));
  }

  // Should detect
  const positives = [
    ["https://a.com/dash", "https://a.com/login"],
    ["https://a.com/dash", "https://a.com/Login"],
    ["https://a.com/dash", "https://a.com/user/signin"],
    ["https://a.com/dash", "https://a.com/sign-in"],
    ["https://a.com/dash", "https://a.com/auth/callback"],
    ["https://a.com/dash", "https://a.com/sso?redirect=/dash"],
    ["https://a.com/dash", "https://a.com/cas/login?service=x"],
    ["https://a.com/page", "https://login.a.com/auth"], // different domain with auth path
  ];
  for (const [init, cur] of positives) {
    assert(`detect: ${new URL(cur).pathname}`, detect(init, cur));
  }

  // Should NOT detect
  const negatives = [
    ["https://a.com/dash", "https://a.com/dash"], // same URL
    ["https://a.com/dash", "https://a.com/other"],
    ["https://a.com/dash", "https://a.com/profile"],
    ["https://a.com/dash", "https://a.com/settings"],
  ];
  for (const [init, cur] of negatives) {
    assert(`no detect: ${init === cur ? "same URL" : new URL(cur).pathname}`, !detect(init, cur));
  }
}

async function main() {
  console.log("=== ユニットテスト ===");
  await testSessionManager();
  await testKeychainAdapter();
  await testKeychainGetPasswordByRef();
  await testLoginRedirectDetection();

  console.log(`\n=== 結果: ${failures === 0 ? "全テスト合格 ✓" : `${failures} 件失敗 ✗`} ===\n`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
