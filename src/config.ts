import os from "node:os";
import path from "node:path";
import fs from "node:fs";

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

export type RuntimeConfig = {
  dataDir: string;
  sessionFile: string;
  sessionEncryptionKey: string;
  browserMode: "cdp" | "launch";
  cdpEndpoint: string;
  cdpProfile: string;
  reusePage: boolean;
  chromeExecutablePath?: string;
  headless: boolean;
  navTimeoutMs: number;
  searchMinIntervalMs: number;
  detailMinIntervalMs: number;
  cooldownMs: number;
  userAgent: string;
};

export function loadConfig(): RuntimeConfig {
  const dataDir = process.env.XHS_DATA_DIR ?? path.join(os.homedir(), ".xiaohongshu-mcp-ts-lite");
  const sessionFile = process.env.XHS_SESSION_FILE ?? path.join(dataDir, "session.enc");
  const sessionEncryptionKey = process.env.XHS_SESSION_ENCRYPTION_KEY ?? "";

  if (!sessionEncryptionKey) {
    throw new Error("XHS_SESSION_ENCRYPTION_KEY is required");
  }

  const browserMode = (process.env.XHS_BROWSER_MODE ?? "cdp").toLowerCase() === "launch" ? "launch" : "cdp";

  const candidateChromePath =
    process.env.XHS_CHROME_EXECUTABLE_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const chromeExecutablePath = fs.existsSync(candidateChromePath)
    ? candidateChromePath
    : undefined;

  const config: RuntimeConfig = {
    dataDir,
    sessionFile,
    sessionEncryptionKey,
    browserMode,
    cdpEndpoint: process.env.XHS_CDP_ENDPOINT ?? "http://127.0.0.1:9222",
    cdpProfile: process.env.XHS_CDP_PROFILE ?? "system-default",
    reusePage: parseBool(process.env.XHS_REUSE_PAGE, true),
    headless: parseBool(process.env.XHS_HEADLESS, false),
    navTimeoutMs: parseIntSafe(process.env.XHS_NAV_TIMEOUT_MS, 30000),
    searchMinIntervalMs: parseIntSafe(process.env.XHS_SEARCH_MIN_INTERVAL_MS, 3000),
    detailMinIntervalMs: parseIntSafe(process.env.XHS_DETAIL_MIN_INTERVAL_MS, 8000),
    cooldownMs: parseIntSafe(process.env.XHS_COOLDOWN_MS, 15 * 60 * 1000),
    userAgent:
      process.env.XHS_USER_AGENT ??
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  };
  if (chromeExecutablePath) {
    config.chromeExecutablePath = chromeExecutablePath;
  }
  return config;
}
