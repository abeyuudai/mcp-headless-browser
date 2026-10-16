import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SessionManager } from "./session-manager.js";
import { resolveStateDir } from "./runtime-env.js";
import { BrowserSessionRegistry } from "./browser-registry.js";
import { registerFetchPage } from "./tools/fetch-page.js";
import { registerBrowseLogin } from "./tools/browse-login.js";
import { registerBrowseStatus } from "./tools/browse-status.js";
import { registerBrowseAction } from "./tools/browse-action.js";
import { registerBrowseScreenshot } from "./tools/browse-screenshot.js";
import { registerBrowseSessionTools } from "./tools/browse-session.js";

let stateDir: string;
try {
  stateDir = resolveStateDir();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const server = new McpServer({
  name: "headless-browser",
  version: "1.2.0",
});

const sessionManager = new SessionManager(stateDir);
const browserRegistry = new BrowserSessionRegistry(sessionManager);

registerFetchPage(server);
registerBrowseLogin(server, sessionManager);
registerBrowseStatus(server, sessionManager);
registerBrowseAction(server, sessionManager);
registerBrowseScreenshot(server, sessionManager, stateDir);
registerBrowseSessionTools(server, sessionManager, browserRegistry);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await browserRegistry.shutdown();
  } catch (err) {
    console.error(`shutdown error (${signal}):`, err);
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
