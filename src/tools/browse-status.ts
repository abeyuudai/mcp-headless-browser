import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SessionManager } from "../session-manager.js";

export function registerBrowseStatus(
  server: McpServer,
  sessionManager: SessionManager
): void {
  server.tool(
    "browse_status",
    "保存済みセッション（Cookie）の状態を確認します。サービス名を指定すると個別確認、省略すると全サービス一覧を表示します。",
    {
      service: z
        .string()
        .regex(/^[a-z0-9_-]+$/)
        .optional()
        .describe("サービス名（省略時は全サービス一覧）"),
    },
    async ({ service }) => {
      if (service) {
        const info = await sessionManager.getInfo(service);
        if (!info.exists) {
          return {
            content: [
              {
                type: "text" as const,
                text: `サービス "${service}" のセッションは保存されていません。`,
              },
            ],
          };
        }
        const updatedAt = info.lastModified!.toLocaleString("ja-JP", {
          timeZone: "Asia/Tokyo",
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `サービス "${service}"\n状態: 保存済み\n最終更新: ${updatedAt}`,
            },
          ],
        };
      }

      // List all sessions
      const sessions = await sessionManager.listAll();
      if (sessions.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "保存済みセッションはありません。",
            },
          ],
        };
      }

      const lines = sessions.map((s) => {
        const updatedAt = s.lastModified!.toLocaleString("ja-JP", {
          timeZone: "Asia/Tokyo",
        });
        return `- ${s.service}: 保存済み (最終更新: ${updatedAt})`;
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `セッション一覧:\n${lines.join("\n")}`,
          },
        ],
      };
    }
  );
}
