import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { RuntimeGuard } from "./guard.js";
import { AppError, type SearchFilters, type ToolCode, type ToolResponse } from "./types.js";
import { XhsClient } from "./xhs-client.js";

const config = loadConfig();
const guard = new RuntimeGuard(
  {
    search_feeds: config.searchMinIntervalMs,
    get_feed_detail: config.detailMinIntervalMs
  },
  config.cooldownMs
);
const xhs = new XhsClient(config);

const server = new McpServer({
  name: "xiaohongshu-mcp-ts-lite",
  version: "0.1.0"
});

function ok<T>(message: string, data: T, meta?: Record<string, unknown>): ToolResponse<T> {
  const response: ToolResponse<T> = {
    success: true,
    code: "ok",
    message,
    data
  };
  if (meta !== undefined) {
    response.meta = meta;
  }
  return response;
}

function fail(code: ToolCode, message: string, meta?: Record<string, unknown>): ToolResponse<null> {
  const response: ToolResponse<null> = {
    success: false,
    code,
    message,
    data: null
  };
  if (meta !== undefined) {
    response.meta = meta;
  }
  return response;
}

function toPayload(response: ToolResponse): { content: Array<{ type: "text"; text: string }>; isError?: true } {
  const payload: { content: Array<{ type: "text"; text: string }>; isError?: true } = {
    content: [
      {
        type: "text",
        text: JSON.stringify(response, null, 2)
      }
    ]
  };
  if (!response.success) {
    payload.isError = true;
  }
  return payload;
}

function toFailure(error: unknown, requestId: string): ToolResponse<null> {
  if (error instanceof AppError) {
    return fail(error.code, error.message, {
      request_id: requestId,
      ...(error.meta ?? {})
    });
  }

  return fail("internal_error", error instanceof Error ? error.message : String(error), {
    request_id: requestId
  });
}

async function runTool<T>(toolName: string, fn: () => Promise<T>): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
  const requestId = randomUUID();
  const started = Date.now();

  try {
    const data = await guard.run(toolName, fn);
    return toPayload(ok("ok", data, {
      request_id: requestId,
      duration_ms: Date.now() - started
    }));
  } catch (error) {
    if (error instanceof AppError && error.code === "platform_blocked") {
      guard.triggerCooldown(error.message);
    }

    return toPayload(toFailure(error, requestId));
  }
}

server.tool(
  "check_login_status",
  "Check current Xiaohongshu login status from web session.",
  {},
  async () => runTool("check_login_status", async () => xhs.checkLoginStatus())
);

server.tool(
  "get_login_qrcode",
  "Get Xiaohongshu login QR code when current session is not logged in.",
  {},
  async () => runTool("get_login_qrcode", async () => xhs.getLoginQrcode())
);

server.tool(
  "search_feeds",
  "Search Xiaohongshu feeds by keyword (read-only).",
  {
    keyword: z.string().min(1),
    filters: z
      .object({
        sort_by: z.string().optional(),
        note_type: z.string().optional(),
        publish_time: z.string().optional(),
        search_scope: z.string().optional(),
        location: z.string().optional()
      })
      .optional()
  },
  async ({ keyword, filters }) =>
    runTool("search_feeds", async () => xhs.searchFeeds(keyword, filters as SearchFilters | undefined))
);

server.tool(
  "get_feed_detail",
  "Get Xiaohongshu feed detail by feed id and xsec token (read-only).",
  {
    feed_id: z.string().min(1),
    xsec_token: z.string().min(1),
    load_all_comments: z.boolean().optional().default(false)
  },
  async ({ feed_id, xsec_token, load_all_comments }) =>
    runTool("get_feed_detail", async () => xhs.getFeedDetail(feed_id, xsec_token, load_all_comments))
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
