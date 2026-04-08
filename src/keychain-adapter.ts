import { execSync } from "node:child_process";

export interface Credentials {
  account: string;
  password: string;
}

export class KeychainAdapter {
  private readonly prefix = "kurosuke.";

  private getServiceName(service: string): string {
    return `${this.prefix}${service}`;
  }

  getCredentials(service: string): Credentials | null {
    const serviceName = this.getServiceName(service);
    try {
      // -g outputs password to stderr, account info to stdout
      const result = execSync(
        `security find-generic-password -s ${quote(serviceName)} -g 2>&1`,
        { encoding: "utf-8" }
      );

      const account = result.match(/"acct"<blob>="(.+?)"/)?.[1] ?? null;
      const password = parsePassword(result);

      if (!account || !password) return null;
      return { account, password };
    } catch {
      return null;
    }
  }

  setCredentials(service: string, account: string, password: string): void {
    const serviceName = this.getServiceName(service);
    // Delete existing entry first (service is unique key, account may change)
    try {
      execSync(`security delete-generic-password -s ${quote(serviceName)} 2>/dev/null`, {
        encoding: "utf-8",
      });
    } catch {
      // Not found — ok
    }
    execSync(
      `security add-generic-password -s ${quote(serviceName)} -a ${quote(account)} -w ${quote(password)}`,
      { encoding: "utf-8" }
    );
  }

  hasCredentials(service: string): boolean {
    return this.getCredentials(service) !== null;
  }

  /**
   * Get password from Keychain by arbitrary service + account.
   * Used by browse_action fill with keychain reference.
   */
  getPasswordByRef(service: string, account: string): string {
    const result = execSync(
      `security find-generic-password -s ${quote(service)} -a ${quote(account)} -w`,
      { encoding: "utf-8" }
    );
    return result.trim();
  }
}

function parsePassword(output: string): string | null {
  // Format: password: "thepassword"
  const quoted = output.match(/password: "(.+?)"/);
  if (quoted) return quoted[1];

  // Format: password: 0x<hex>  "<readable>" (binary data)
  const hex = output.match(/password: 0x([0-9A-Fa-f]+)/);
  if (hex) return Buffer.from(hex[1], "hex").toString("utf-8");

  return null;
}

function quote(s: string): string {
  // Shell-safe quoting: wrap in single quotes, escape embedded single quotes
  return `'${s.replace(/'/g, "'\\''")}'`;
}
