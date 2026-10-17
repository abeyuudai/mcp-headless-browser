import { isAbsolute } from "node:path";
import type { LaunchOptions } from "playwright";

export const STATE_DIR_ENV = "HEADLESS_BROWSER_STATE_DIR";

export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const value = env[STATE_DIR_ENV];
  if (!value) {
    throw new Error(
      `${STATE_DIR_ENV} is not set. Set it to an absolute directory path where login sessions and screenshots are stored.`
    );
  }
  if (!isAbsolute(value)) {
    throw new Error(
      `${STATE_DIR_ENV} must be an absolute path (got "${value}").`
    );
  }
  return value;
}

// Chromium only starts inside the sandbox with --single-process.
export function chromiumLaunchArgs(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  return env.SANDBOX_RUNTIME || env.CODEX_SANDBOX ? ["--single-process"] : [];
}

const PROXY_ENV_ORDER = [
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "HTTP_PROXY",
  "http_proxy",
];

export function chromiumProxy(
  env: NodeJS.ProcessEnv = process.env
): NonNullable<LaunchOptions["proxy"]> | undefined {
  const raw = PROXY_ENV_ORDER.map((k) => env[k]).find((v) => v);
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const bypass = env.NO_PROXY || env.no_proxy;
  return {
    server: `${url.protocol}//${url.host}`,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    ...(bypass ? { bypass } : {}),
  };
}

// Chromium ignores the *_PROXY env vars; pass them as Playwright's proxy option so the sandbox's proxy is used.
export function chromiumLaunchOptions(
  { headless }: { headless: boolean },
  env: NodeJS.ProcessEnv = process.env
): LaunchOptions {
  const proxy = chromiumProxy(env);
  return { headless, args: chromiumLaunchArgs(env), ...(proxy ? { proxy } : {}) };
}
