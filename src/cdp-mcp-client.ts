import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { RuntimeConfig } from "./config.js";
import { AppError } from "./types.js";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type CdpPayload = {
  success: boolean;
  code: string;
  message: string;
  data: JsonValue;
};

type CallToolResult = {
  content: Array<{ type: string; text?: string }>;
};

export class CdpMcpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  public constructor(private readonly config: RuntimeConfig) {}

  public async connect(): Promise<void> {
    if (this.client) {
      return;
    }

    const env = {
      ...process.env,
      CDP_ENDPOINT: this.config.cdpEndpoint
    };

    const transport = new StdioClientTransport({
      command: this.config.cdpMcpCommand,
      args: this.config.cdpMcpArgs,
      env
    } satisfies StdioServerParameters);

    const client = new Client({
      name: "xiaohongshu-mcp-ts-lite",
      version: "0.1.0"
    });

    try {
      await client.connect(transport);
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw new AppError("internal_error", `failed to connect cdp-browser-mcp: ${this.errorMessage(error)}`);
    }

    this.transport = transport;
    this.client = client;
  }

  public async close(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    this.client = null;
    if (transport) {
      await transport.close().catch(() => undefined);
    }
  }

  public async callTool<T = JsonValue>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    await this.connect();
    const client = this.client;
    if (!client) {
      throw new AppError("internal_error", "cdp mcp client is not connected");
    }

    let result: unknown;
    try {
      result = await client.callTool({
        name,
        arguments: args
      });
    } catch (error) {
      throw new AppError("internal_error", `cdp mcp tool '${name}' call failed: ${this.errorMessage(error)}`);
    }

    const payload = this.extractPayload(result as CallToolResult);
    if (!payload.success) {
      throw new AppError("internal_error", payload.message || `cdp tool '${name}' failed`, {
        cdp_tool: name,
        cdp_code: payload.code
      });
    }

    return payload.data as T;
  }

  private extractPayload(result: CallToolResult): CdpPayload {
    const textItem = result.content.find((item) => item.type === "text");
    const text = textItem?.text;
    if (!text) {
      throw new AppError("internal_error", "cdp tool response missing text payload");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new AppError("internal_error", `cdp tool response is not valid json: ${this.errorMessage(error)}`);
    }

    if (!parsed || typeof parsed !== "object") {
      throw new AppError("internal_error", "cdp tool response json must be an object");
    }

    const payload = parsed as Partial<CdpPayload>;
    if (
      typeof payload.success !== "boolean" ||
      typeof payload.code !== "string" ||
      typeof payload.message !== "string" ||
      payload.data === undefined
    ) {
      throw new AppError("internal_error", "cdp tool response json has invalid shape");
    }

    return payload as CdpPayload;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
