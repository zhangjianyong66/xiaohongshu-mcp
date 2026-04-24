function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseIntSafe(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseJsonArray(value: string | undefined): string[] {
  if (!value) {
    throw new Error("XHS_CDP_MCP_ARGS is required and must be a JSON string array");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `XHS_CDP_MCP_ARGS must be valid JSON array: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error("XHS_CDP_MCP_ARGS must be a JSON array of non-empty strings");
  }

  return parsed;
}

export type RuntimeConfig = {
  cdpMcpCommand: string;
  cdpMcpArgs: string[];
  cdpEndpoint: string;
  cdpProfile: string;
  reusePage: boolean;
  navTimeoutMs: number;
  searchMinIntervalMs: number;
  detailMinIntervalMs: number;
  cooldownMs: number;
  userAgent: string;
  autoStartChrome: boolean;
};

export function loadConfig(): RuntimeConfig {
  return {
    cdpMcpCommand: process.env.XHS_CDP_MCP_COMMAND ?? "node",
    cdpMcpArgs: parseJsonArray(process.env.XHS_CDP_MCP_ARGS),
    cdpEndpoint: process.env.XHS_CDP_ENDPOINT ?? "http://127.0.0.1:9222",
    cdpProfile: process.env.XHS_CDP_PROFILE ?? "system-default",
    reusePage: parseBool(process.env.XHS_REUSE_PAGE, true),
    navTimeoutMs: parseIntSafe(process.env.XHS_NAV_TIMEOUT_MS, 30000),
    searchMinIntervalMs: parseIntSafe(process.env.XHS_SEARCH_MIN_INTERVAL_MS, 3000),
    detailMinIntervalMs: parseIntSafe(process.env.XHS_DETAIL_MIN_INTERVAL_MS, 8000),
    cooldownMs: parseIntSafe(process.env.XHS_COOLDOWN_MS, 15 * 60 * 1000),
    userAgent:
      process.env.XHS_USER_AGENT ??
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    autoStartChrome: parseBool(process.env.XHS_AUTO_START_CHROME, true)
  };
}
