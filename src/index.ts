import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { chromium } from "playwright";

const server = new McpServer({
  name: "headless-browser",
  version: "1.0.0",
});

server.tool(
  "fetch_page",
  "Fetch a web page using a headless browser (supports JavaScript-rendered content like X/Twitter). Usually works fine with the default 1-second wait. Only increase wait_seconds if content is missing.",
  {
    url: z.string().url().describe("The URL to fetch"),
    wait_seconds: z
      .number()
      .min(1)
      .max(30)
      .default(1)
      .describe("Seconds to wait for page to load (default: 1). Increase to 2-5 only if content is not fully loaded"),
  },
  async ({ url, wait_seconds }) => {
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        locale: "ja-JP",
      });
      const page = await context.newPage();

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(wait_seconds * 1000);

      const title = await page.title();
      const text = await page.evaluate(() => {
        // Remove script, style, noscript tags
        const removeSelectors = ["script", "style", "noscript", "nav", "footer", "header"];
        for (const sel of removeSelectors) {
          document.querySelectorAll(sel).forEach((el) => el.remove());
        }

        // Try to get main content first
        const main =
          document.querySelector("main") ||
          document.querySelector("article") ||
          document.querySelector('[role="main"]');
        const target = main || document.body;

        return target?.innerText?.trim() || "";
      });

      const pageUrl = page.url();

      await browser.close();

      const result = [`Title: ${title}`, `URL: ${pageUrl}`, "", text].join("\n");

      return {
        content: [{ type: "text" as const, text: result }],
      };
    } catch (error) {
      if (browser) await browser.close();
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error fetching page: ${message}` }],
        isError: true,
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
