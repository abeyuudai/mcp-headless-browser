import type { Page } from "playwright";

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Common username/password selectors (tried in order)
export const DEFAULT_USERNAME_SELECTORS = [
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

export const DEFAULT_PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name="password"]',
  'input[name="pass"]',
  'input[name="passwd"]',
];

export async function autoFill(
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

// Common login page URL patterns
export const LOGIN_URL_PATTERNS = [
  /login/i,
  /signin/i,
  /sign-in/i,
  /auth/i,
  /sso/i,
  /cas\/login/i,
];

export function detectLoginRedirect(initialUrl: string, currentUrl: string): boolean {
  // Only flag if we were redirected to a different URL that looks like a login page
  if (initialUrl === currentUrl) return false;
  const currentPath = new URL(currentUrl).pathname + new URL(currentUrl).search;
  return LOGIN_URL_PATTERNS.some((pattern) => pattern.test(currentPath));
}

/**
 * Generate a stable CSS selector for a DOM element.
 * Priority: #id > [name=...] > [data-testid=...] > tag.class > nth-of-type fallback.
 * Used by browse_inspect to give Claude a reliable selector for each form field.
 *
 * Note: this function runs in browser context (passed to page.evaluate),
 * so it must be self-contained (no external references).
 */
export function generateCssSelectorScript(): string {
  return `
function generateCssSelector(el) {
  if (!el || el.nodeType !== 1) return '';

  // Priority 1: id
  if (el.id) {
    return '#' + CSS.escape(el.id);
  }

  // Priority 2: name attribute
  const name = el.getAttribute('name');
  if (name) {
    return el.tagName.toLowerCase() + '[name=' + JSON.stringify(name) + ']';
  }

  // Priority 3: data-testid
  const testid = el.getAttribute('data-testid');
  if (testid) {
    return '[data-testid=' + JSON.stringify(testid) + ']';
  }

  // Priority 4: tag + first class
  const tag = el.tagName.toLowerCase();
  if (el.classList.length > 0) {
    const cls = CSS.escape(el.classList[0]);
    const candidate = tag + '.' + cls;
    if (document.querySelectorAll(candidate).length === 1) {
      return candidate;
    }
  }

  // Priority 5: nth-of-type fallback (walk up the DOM)
  function nthOfType(node) {
    const parent = node.parentElement;
    if (!parent) return node.tagName.toLowerCase();
    const siblings = Array.from(parent.children).filter(
      (c) => c.tagName === node.tagName
    );
    const idx = siblings.indexOf(node) + 1;
    const selfSel = node.tagName.toLowerCase() + ':nth-of-type(' + idx + ')';
    if (parent === document.body) return selfSel;
    return nthOfType(parent) + ' > ' + selfSel;
  }

  return nthOfType(el);
}
`.trim();
}
