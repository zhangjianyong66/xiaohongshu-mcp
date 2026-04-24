import type { RuntimeConfig } from "./config.js";
import { AppError } from "./types.js";
import { CdpMcpClient } from "./cdp-mcp-client.js";

type TabInfo = {
  tab_id: string;
  url: string;
  title: string;
};

type ListTabsResponse = {
  count: number;
  tabs: TabInfo[];
};

type EvalResponse<T> = {
  tab_id: string;
  value: T;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class McpCdpBrowserDriver {
  private tabId: string | null = null;

  public constructor(
    private readonly client: CdpMcpClient,
    private readonly config: RuntimeConfig
  ) {}

  public async ensureReady(): Promise<void> {
    try {
      await this.client.callTool("cdp_health");
      return;
    } catch (healthError) {
      if (!this.config.autoStartChrome) {
        throw healthError;
      }
    }

    await this.client.callTool("start_chrome_cdp");

    const startedAt = Date.now();
    let lastError: unknown;
    while (Date.now() - startedAt < 15000) {
      try {
        await this.client.callTool("cdp_health");
        return;
      } catch (error) {
        lastError = error;
        await sleep(500);
      }
    }

    throw new AppError("internal_error", `cdp endpoint still unavailable after auto start: ${this.errorMessage(lastError)}`);
  }

  public async ensureTab(): Promise<string> {
    if (this.tabId) {
      const tabs = await this.listTabs();
      const existing = tabs.tabs.find((tab) => tab.tab_id === this.tabId);
      if (existing) {
        return existing.tab_id;
      }
      this.tabId = null;
    }

    const tabs = await this.listTabs();
    const preferred =
      tabs.tabs.find((tab) => tab.url.includes("xiaohongshu.com")) ??
      tabs.tabs.find((tab) => tab.url.startsWith("http"));

    if (preferred) {
      this.tabId = preferred.tab_id;
      return preferred.tab_id;
    }

    const created = await this.client.callTool<{ tab_id: string }>("new_tab", {
      url: "https://www.xiaohongshu.com/explore"
    });

    if (!created.tab_id) {
      throw new AppError("internal_error", "failed to create browser tab via cdp mcp");
    }

    this.tabId = created.tab_id;
    return created.tab_id;
  }

  public async navigate(url: string): Promise<void> {
    const tabId = await this.ensureTab();
    await this.client.callTool("navigate", {
      tab_id: tabId,
      url,
      wait_until: "domcontentloaded"
    });
  }

  public async evaluate<T>(script: string): Promise<T> {
    const tabId = await this.ensureTab();
    const response = await this.client.callTool<EvalResponse<T>>("evaluate_js", {
      tab_id: tabId,
      script
    });
    return response.value;
  }

  public async waitFor<T>(
    script: string,
    isReady: (value: T) => boolean,
    timeoutMs: number,
    intervalMs = 300
  ): Promise<T> {
    const startedAt = Date.now();
    let lastValue: T | undefined;
    while (Date.now() - startedAt < timeoutMs) {
      lastValue = await this.evaluate<T>(script);
      if (isReady(lastValue)) {
        return lastValue;
      }
      await sleep(intervalMs);
    }

    throw new AppError("timeout", "browser wait condition timed out", {
      timeout_ms: timeoutMs,
      last_value: lastValue ?? null
    });
  }

  public async closeTab(): Promise<void> {
    if (!this.tabId) {
      return;
    }

    const tabId = this.tabId;
    this.tabId = null;
    await this.client.callTool("close_tab", { tab_id: tabId }).catch(() => undefined);
  }

  private async listTabs(): Promise<ListTabsResponse> {
    return this.client.callTool<ListTabsResponse>("list_tabs");
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
