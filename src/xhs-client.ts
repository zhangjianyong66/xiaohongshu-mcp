import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page
} from "playwright";
import type { RuntimeConfig } from "./config.js";
import { SessionStore } from "./session-store.js";
import { AppError, type FeedItem, type SearchFilters } from "./types.js";

const RISK_PATTERNS = [
  "sorry, this page isn't available right now",
  "请打开小红书app扫码查看",
  "请打开小红书app",
  "当前内容无法在网页端展示",
  "访问过于频繁",
  "安全验证"
];

type SearchResult = {
  feeds: FeedItem[];
  count: number;
  keyword: string;
  filters?: SearchFilters;
};

type FeedDetailResult = {
  feed_id: string;
  xsec_token: string;
  note_detail: unknown;
};

export class XhsClient {
  public constructor(
    private readonly config: RuntimeConfig,
    private readonly sessions: SessionStore
  ) {}

  public async checkLoginStatus(): Promise<{ is_logged_in: boolean; username?: string }> {
    return this.withPage(async (page) => {
      await this.openExplore(page);
      const loggedIn = await this.isLoggedIn(page);
      if (!loggedIn) {
        return { is_logged_in: false };
      }

      const username = await page.evaluate(() => {
        const el = document.querySelector(".main-container .user .link-wrapper .channel");
        return (el?.textContent ?? "").trim() || undefined;
      });

      if (username) {
        return {
          is_logged_in: true,
          username
        };
      }

      return {
        is_logged_in: true
      };
    });
  }

  public async getLoginQrcode(): Promise<{ is_logged_in: boolean; qr_code?: { type: "data_url" | "url"; value: string } }> {
    return this.withPage(async (page) => {
      await this.openExplore(page);

      if (await this.isLoggedIn(page)) {
        return { is_logged_in: true };
      }

      await page.waitForSelector(".login-container .qrcode-img", {
        timeout: this.config.navTimeoutMs
      });

      const src = await page.getAttribute(".login-container .qrcode-img", "src");
      if (!src) {
        throw new AppError("internal_error", "failed to read qrcode src");
      }

      return {
        is_logged_in: false,
        qr_code: {
          type: src.startsWith("data:image") ? "data_url" : "url",
          value: src
        }
      };
    });
  }

  public async searchFeeds(keyword: string, filters?: SearchFilters): Promise<SearchResult> {
    return this.withPage(async (page) => {
      const encoded = encodeURIComponent(keyword);
      const url = `https://www.xiaohongshu.com/search_result?keyword=${encoded}&source=web_explore_feed`;

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: this.config.navTimeoutMs });
      await page.waitForFunction(() => Boolean((window as unknown as { __INITIAL_STATE__?: unknown }).__INITIAL_STATE__), {
        timeout: this.config.navTimeoutMs
      });

      await this.detectRisk(page);

      const feeds = await page.evaluate(() => {
        const state = (window as unknown as {
          __INITIAL_STATE__?: {
            search?: {
              feeds?: {
                value?: unknown;
                _value?: unknown;
              };
            };
          };
        }).__INITIAL_STATE__;

        const raw = state?.search?.feeds?.value ?? state?.search?.feeds?._value;
        return Array.isArray(raw) ? raw : [];
      });

      const response: SearchResult = {
        feeds: feeds as FeedItem[],
        count: Array.isArray(feeds) ? feeds.length : 0,
        keyword
      };
      if (filters !== undefined) {
        response.filters = filters;
      }
      return response;
    });
  }

  public async getFeedDetail(feedId: string, xsecToken: string, loadAllComments = false): Promise<FeedDetailResult> {
    if (loadAllComments) {
      throw new AppError(
        "invalid_input",
        "load_all_comments=true is disabled in ts-lite v1 to reduce platform risk"
      );
    }

    return this.withPage(async (page) => {
      const url = `https://www.xiaohongshu.com/explore/${encodeURIComponent(feedId)}?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_feed`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: this.config.navTimeoutMs });
      await page.waitForFunction(() => Boolean((window as unknown as { __INITIAL_STATE__?: unknown }).__INITIAL_STATE__), {
        timeout: this.config.navTimeoutMs
      });

      await this.detectRisk(page);

      const noteDetail = await page.evaluate((id) => {
        const state = (window as unknown as {
          __INITIAL_STATE__?: {
            note?: {
              noteDetailMap?: Record<string, unknown>;
            };
          };
        }).__INITIAL_STATE__;

        return state?.note?.noteDetailMap?.[id] ?? null;
      }, feedId);

      if (!noteDetail) {
        throw new AppError("internal_error", "note detail not found in initial state");
      }

      return {
        feed_id: feedId,
        xsec_token: xsecToken,
        note_detail: noteDetail
      };
    });
  }

  private async withPage<T>(runner: (page: Page) => Promise<T>): Promise<T> {
    const state = await this.sessions.load();
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;

    try {
      browser = await chromium.launch({
        headless: this.config.headless
      });

      const contextOptions: BrowserContextOptions = {
        userAgent: this.config.userAgent,
        locale: "zh-CN",
        viewport: { width: 1440, height: 900 }
      };
      if (state !== undefined) {
        contextOptions.storageState = state;
      }

      context = await browser.newContext(contextOptions);

      const page = await context.newPage();
      page.setDefaultTimeout(this.config.navTimeoutMs);

      const result = await runner(page);

      const nextState = await context.storageState();
      await this.sessions.save(nextState);

      return result;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      if (/timeout/i.test(message)) {
        throw new AppError("timeout", message);
      }
      throw new AppError("internal_error", message);
    } finally {
      await context?.close();
      await browser?.close();
    }
  }

  private async openExplore(page: Page): Promise<void> {
    await page.goto("https://www.xiaohongshu.com/explore", {
      waitUntil: "domcontentloaded",
      timeout: this.config.navTimeoutMs
    });
  }

  private async isLoggedIn(page: Page): Promise<boolean> {
    const el = await page.$(".main-container .user .link-wrapper .channel");
    return Boolean(el);
  }

  private async detectRisk(page: Page): Promise<void> {
    const text = (await page.content()).toLowerCase();
    for (const pattern of RISK_PATTERNS) {
      if (text.includes(pattern)) {
        throw new AppError("platform_blocked", `risk control detected: ${pattern}`);
      }
    }
  }
}
