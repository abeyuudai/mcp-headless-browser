import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SessionManager } from "./session-manager.js";
import { registerFetchPage } from "./tools/fetch-page.js";
import { registerBrowseLogin } from "./tools/browse-login.js";
import { registerBrowseStatus } from "./tools/browse-status.js";
import { registerBrowseAction } from "./tools/browse-action.js";
import { registerBrowseScreenshot } from "./tools/browse-screenshot.js";

const server = new McpServer({
  name: "headless-browser",
  version: "1.1.0",
});

const sessionManager = new SessionManager();

registerFetchPage(server);
registerBrowseLogin(server, sessionManager);
registerBrowseStatus(server, sessionManager);
registerBrowseAction(server, sessionManager);
registerBrowseScreenshot(server, sessionManager);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
