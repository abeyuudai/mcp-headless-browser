import { isAbsolute } from "node:path";

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
