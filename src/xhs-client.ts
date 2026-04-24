import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type LaunchOptions,
  type Page
} from "playwright";
import fs from "node:fs/promises";
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

type QrImageInfo = {
  local_path: string;
  mime_type: "image/png";
  width: number;
  height: number;
  size_bytes: number;
  source: "local_file";
};

const QR_OUTPUT_DIR = "/tmp/openclaw";
const QR_OUTPUT_PATH = `${QR_OUTPUT_DIR}/xhs-login-qrcode.png`;
const LOGIN_PENDING_TIMEOUT_MS = 4 * 60 * 1000;
const LOGIN_SUCCESS_KEEPALIVE_MS = 60 * 60 * 1000;
const LOGIN_POLL_INTERVAL_MS = 1000;

type LoginSessionStatus = "pending" | "success";

type RuntimeSession = {
  mode: "cdp" | "launch";
  browser: Browser;
  context: BrowserContext;
  sharedPage: Page | null;
};

type AcquiredPage = {
  page: Page;
  release: () => Promise<void>;
};

type LoginSession = {
  status: LoginSessionStatus;
  context: BrowserContext;
  page: Page;
  qrCodeSrc: string;
  expiresAt: number;
  cleanupTimer: NodeJS.Timeout | null;
  pollTimer: NodeJS.Timeout | null;
};

type LoginState = "logged_in" | "logged_out" | "unknown";

export class XhsClient {
  private runtimeSession: RuntimeSession | null = null;
  private loginSession: LoginSession | null = null;

  public constructor(
    private readonly config: RuntimeConfig,
    private readonly sessions: SessionStore
  ) {}

  public async checkLoginStatus(): Promise<{ is_logged_in: boolean; username?: string }> {
    const activeLoginSession = await this.getActiveLoginSession();
    if (activeLoginSession) {
      if (activeLoginSession.status === "success") {
        const username = await this.readUsername(activeLoginSession.page);
        if (username) {
          return { is_logged_in: true, username };
        }
        return { is_logged_in: true };
      }
      return { is_logged_in: false };
    }

    return this.withPage(async (page) => {
      await this.openExplore(page);
      const loggedIn = await this.isLoggedIn(page);
      if (!loggedIn) {
        return { is_logged_in: false };
      }

      const username = await this.readUsername(page);
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

  public async getLoginQrcode(): Promise<{
    is_logged_in: boolean;
    qr_local_path?: string;
    qr_image?: QrImageInfo;
    login_session?: {
      status: "pending" | "success";
      expires_at: string;
      reused: boolean;
    };
  }> {
    const existing = await this.getActiveLoginSession();
    if (existing) {
      if (existing.status === "success") {
        return { is_logged_in: true };
      }
      await this.ensureQrcodeFileReadyOrRewrite(existing);
      const qrImage = await this.buildQrcodeInfo();
      return {
        is_logged_in: false,
        qr_local_path: QR_OUTPUT_PATH,
        qr_image: qrImage,
        login_session: {
          status: existing.status,
          expires_at: new Date(existing.expiresAt).toISOString(),
          reused: true
        }
      };
    }

    const runtime = await this.getOrCreateRuntimeSession();
    const page = await runtime.context.newPage();
    page.setDefaultTimeout(this.config.navTimeoutMs);

    try {
      await this.openExplore(page);
      if (await this.isLoggedIn(page)) {
        await this.saveSessionState(runtime.context);
        await page.close().catch(() => undefined);
        return { is_logged_in: true };
      }

      await page.waitForSelector(".login-container .qrcode-img", {
        timeout: this.config.navTimeoutMs
      });

      const src = await page.getAttribute(".login-container .qrcode-img", "src");
      if (!src) {
        throw new AppError("internal_error", "failed to read qrcode src");
      }

      await this.persistQrcode(src);
      await this.ensureQrcodeFileReady();
      const qrImage = await this.buildQrcodeInfo();

      const session: LoginSession = {
        status: "pending",
        context: runtime.context,
        page,
        qrCodeSrc: src,
        expiresAt: Date.now() + LOGIN_PENDING_TIMEOUT_MS,
        cleanupTimer: null,
        pollTimer: null
      };
      this.loginSession = session;
      this.scheduleCleanup(session, LOGIN_PENDING_TIMEOUT_MS);
      this.scheduleLoginPolling(session);

      return {
        is_logged_in: false,
        qr_local_path: QR_OUTPUT_PATH,
        qr_image: qrImage,
        login_session: {
          status: session.status,
          expires_at: new Date(session.expiresAt).toISOString(),
          reused: false
        }
      };
    } catch (error) {
      await page.close().catch(() => undefined);
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError("internal_error", error instanceof Error ? error.message : String(error));
    }
  }

  public async searchFeeds(keyword: string, filters?: SearchFilters): Promise<SearchResult> {
    return this.withPage(async (page) => {
      await this.ensureLoggedInForRead(page);

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
      await this.ensureLoggedInForRead(page);

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
    const runtime = await this.getOrCreateRuntimeSession();
    const { page, release } = await this.acquirePage(runtime);

    try {
      const result = await runner(page);
      await this.saveSessionState(runtime.context);
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
      await release();
    }
  }

  private async getOrCreateRuntimeSession(): Promise<RuntimeSession> {
    const current = this.runtimeSession;
    if (current && this.isRuntimeSessionAlive(current)) {
      return current;
    }

    if (current) {
      await this.disposeRuntimeSession(current);
    }

    if (this.config.browserMode === "cdp") {
      let browser: Browser;
      try {
        browser = await chromium.connectOverCDP(this.config.cdpEndpoint);
      } catch (error) {
        throw new AppError(
          "internal_error",
          `failed to connect CDP endpoint: ${this.config.cdpEndpoint}. ensure system Chrome CDP is running`,
          {
            browser_mode: this.config.browserMode,
            cdp_endpoint: this.config.cdpEndpoint,
            cdp_profile: this.config.cdpProfile,
            cause: error instanceof Error ? error.message : String(error)
          }
        );
      }
      const context = (await this.selectBestCdpContext(browser)) ?? (await browser.newContext({
        userAgent: this.config.userAgent,
        locale: "zh-CN",
        viewport: { width: 1440, height: 900 }
      }));
      const session: RuntimeSession = {
        mode: "cdp",
        browser,
        context,
        sharedPage: null
      };
      this.runtimeSession = session;
      return session;
    }

    const launchOptions: LaunchOptions = {
      headless: this.config.headless
    };
    if (this.config.chromeExecutablePath) {
      launchOptions.executablePath = this.config.chromeExecutablePath;
    }
    const browser = await chromium.launch(launchOptions);

    const contextOptions: BrowserContextOptions = {
      userAgent: this.config.userAgent,
      locale: "zh-CN",
      viewport: { width: 1440, height: 900 }
    };
    const state = await this.sessions.load();
    if (state !== undefined) {
      contextOptions.storageState = state;
    }
    const context = await browser.newContext(contextOptions);

    const session: RuntimeSession = {
      mode: "launch",
      browser,
      context,
      sharedPage: null
    };
    this.runtimeSession = session;
    return session;
  }

  private isRuntimeSessionAlive(session: RuntimeSession): boolean {
    if (this.runtimeSession !== session) {
      return false;
    }
    if (!session.browser.isConnected()) {
      return false;
    }
    return true;
  }

  private async disposeRuntimeSession(session: RuntimeSession): Promise<void> {
    if (this.runtimeSession === session) {
      this.runtimeSession = null;
    }

    if (session.mode === "launch") {
      await session.context.close().catch(() => undefined);
      await session.browser.close().catch(() => undefined);
      return;
    }

    session.sharedPage = null;
    await session.browser.close().catch(() => undefined);
  }

  private async acquirePage(session: RuntimeSession): Promise<AcquiredPage> {
    if (this.config.reusePage) {
      if (session.sharedPage && !session.sharedPage.isClosed()) {
        session.sharedPage.setDefaultTimeout(this.config.navTimeoutMs);
        return {
          page: session.sharedPage,
          release: async () => undefined
        };
      }

      const existing = session.context.pages().find((p) => {
        if (p.isClosed()) {
          return false;
        }
        const url = p.url();
        return url.includes("xiaohongshu.com");
      }) ?? session.context.pages().find((p) => !p.isClosed());
      if (existing) {
        existing.setDefaultTimeout(this.config.navTimeoutMs);
        session.sharedPage = existing;
        return {
          page: existing,
          release: async () => undefined
        };
      }

      const created = await session.context.newPage();
      created.setDefaultTimeout(this.config.navTimeoutMs);
      session.sharedPage = created;
      return {
        page: created,
        release: async () => undefined
      };
    }

    const page = await session.context.newPage();
    page.setDefaultTimeout(this.config.navTimeoutMs);
    return {
      page,
      release: async () => {
        await page.close().catch(() => undefined);
      }
    };
  }

  private async saveSessionState(context: BrowserContext): Promise<void> {
    try {
      const nextState = await context.storageState();
      await this.sessions.save(nextState);
    } catch (error) {
      process.stderr.write(`[xhs] save session state failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  private async openExplore(page: Page): Promise<void> {
    await page.goto("https://www.xiaohongshu.com/explore", {
      waitUntil: "domcontentloaded",
      timeout: this.config.navTimeoutMs
    });
  }

  private async ensureLoggedInForRead(page: Page): Promise<void> {
    const activeLoginSession = await this.getActiveLoginSession();
    if (activeLoginSession?.status === "success") {
      return;
    }

    await this.openExplore(page);
    const state = await this.detectLoginState(page);
    if (state !== "logged_out") {
      return;
    }
    throw new AppError("login_required", "xiaohongshu login required, call get_login_qrcode first", {
      next_action: "get_login_qrcode",
      login_state: state
    });
  }

  private async isLoggedIn(page: Page): Promise<boolean> {
    const state = await this.detectLoginState(page);
    return state === "logged_in" || state === "unknown";
  }

  private async detectLoginState(page: Page): Promise<LoginState> {
    const hasLoginQr = await page
      .$(".login-container .qrcode-img, .login-mask .qrcode-img")
      .then((el) => Boolean(el));

    const hasUserMarker = await page
      .$(".main-container .user .link-wrapper .channel, a[href*=\"/user/profile/\"], .reds-avatar")
      .then((el) => Boolean(el));
    if (hasUserMarker) {
      return "logged_in";
    }

    const hasAuthCookie = await this.hasAuthCookie(page);
    if (hasAuthCookie) {
      return "logged_in";
    }

    if (hasLoginQr) {
      return "logged_out";
    }

    return "unknown";
  }

  private async hasAuthCookie(page: Page): Promise<boolean> {
    const cookies = await page.context().cookies("https://www.xiaohongshu.com");
    const authCookieNames = this.getAuthCookieNames();
    return cookies.some((cookie) => {
      if (!cookie.value) {
        return false;
      }
      return authCookieNames.has(cookie.name);
    });
  }

  private async selectBestCdpContext(browser: Browser): Promise<BrowserContext | undefined> {
    const contexts = browser.contexts();
    if (contexts.length === 0) {
      return undefined;
    }

    const authCookieNames = this.getAuthCookieNames();
    for (const context of contexts) {
      try {
        const cookies = await context.cookies("https://www.xiaohongshu.com");
        const hasAuth = cookies.some((cookie) => cookie.value && authCookieNames.has(cookie.name));
        if (hasAuth) {
          return context;
        }
      } catch {
        continue;
      }
    }

    return contexts[0];
  }

  private getAuthCookieNames(): Set<string> {
    return new Set(["web_session", "websectiga", "web_session_sid", "a1", "gid"]);
  }

  private async detectRisk(page: Page): Promise<void> {
    const text = (await page.content()).toLowerCase();
    for (const pattern of RISK_PATTERNS) {
      if (text.includes(pattern)) {
        throw new AppError("platform_blocked", `risk control detected: ${pattern}`);
      }
    }
  }

  private async getActiveLoginSession(): Promise<LoginSession | undefined> {
    const session = this.loginSession;
    if (!session) {
      return undefined;
    }

    if (!this.isLoginSessionAlive(session)) {
      await this.closeLoginSession(session);
      return undefined;
    }

    if (session.status === "pending") {
      const loggedIn = await this.isLoggedIn(session.page);
      if (loggedIn) {
        await this.markLoginSessionSuccess(session);
      } else if (Date.now() >= session.expiresAt) {
        await this.closeLoginSession(session);
        return undefined;
      }
    }

    return this.loginSession ?? undefined;
  }

  private isLoginSessionAlive(session: LoginSession): boolean {
    if (this.loginSession !== session) {
      return false;
    }
    if (session.page.isClosed()) {
      return false;
    }
    return true;
  }

  private scheduleLoginPolling(session: LoginSession): void {
    session.pollTimer = setTimeout(async () => {
      if (!this.isLoginSessionAlive(session) || session.status !== "pending") {
        return;
      }

      try {
        const loggedIn = await this.isLoggedIn(session.page);
        if (loggedIn) {
          await this.markLoginSessionSuccess(session);
          return;
        }
      } catch (error) {
        process.stderr.write(`[xhs] login polling failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }

      this.scheduleLoginPolling(session);
    }, LOGIN_POLL_INTERVAL_MS);
  }

  private async markLoginSessionSuccess(session: LoginSession): Promise<void> {
    if (!this.isLoginSessionAlive(session)) {
      return;
    }
    if (session.status === "success") {
      return;
    }

    await this.saveSessionState(session.context);

    session.status = "success";
    session.expiresAt = Date.now() + LOGIN_SUCCESS_KEEPALIVE_MS;
    if (session.pollTimer) {
      clearTimeout(session.pollTimer);
      session.pollTimer = null;
    }
    this.scheduleCleanup(session, LOGIN_SUCCESS_KEEPALIVE_MS);
  }

  private scheduleCleanup(session: LoginSession, ms: number): void {
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
    }
    session.cleanupTimer = setTimeout(() => {
      void this.closeLoginSession(session);
    }, ms);
  }

  private async closeLoginSession(session: LoginSession): Promise<void> {
    if (this.loginSession !== session) {
      return;
    }

    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
      session.cleanupTimer = null;
    }
    if (session.pollTimer) {
      clearTimeout(session.pollTimer);
      session.pollTimer = null;
    }

    this.loginSession = null;
    await session.page.close().catch(() => undefined);
  }

  private async ensureQrcodeFileReadyOrRewrite(session: LoginSession): Promise<void> {
    try {
      await this.ensureQrcodeFileReady();
      return;
    } catch {
      const src = await session.page.getAttribute(".login-container .qrcode-img", "src");
      if (!src) {
        throw new AppError("internal_error", "failed to refresh qrcode from active login session");
      }
      session.qrCodeSrc = src;
      await this.persistQrcode(src);
      await this.ensureQrcodeFileReady();
    }
  }

  private async readUsername(page: Page): Promise<string | undefined> {
    return page.evaluate(() => {
      const el = document.querySelector(".main-container .user .link-wrapper .channel");
      return (el?.textContent ?? "").trim() || undefined;
    });
  }

  private async persistQrcode(src: string): Promise<void> {
    await fs.mkdir(QR_OUTPUT_DIR, { recursive: true });

    if (src.startsWith("data:image")) {
      const match = src.match(/^data:image\/[a-zA-Z0-9+.-]+;base64,(.+)$/);
      if (!match?.[1]) {
        throw new AppError("internal_error", "invalid qrcode data url");
      }

      const buffer = Buffer.from(match[1], "base64");
      if (buffer.length === 0) {
        throw new AppError("internal_error", "decoded qrcode image is empty");
      }

      await fs.writeFile(QR_OUTPUT_PATH, buffer);
      return;
    }

    const response = await fetch(src);
    if (!response.ok) {
      throw new AppError("internal_error", `failed to download qrcode image: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length === 0) {
      throw new AppError("internal_error", "downloaded qrcode image is empty");
    }

    await fs.writeFile(QR_OUTPUT_PATH, buffer);
  }

  private async ensureQrcodeFileReady(): Promise<void> {
    try {
      const stat = await fs.stat(QR_OUTPUT_PATH);
      if (!stat.isFile()) {
        throw new AppError("internal_error", "qrcode output path is not a file");
      }
      if (stat.size <= 0) {
        throw new AppError("internal_error", "qrcode output file is empty");
      }
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError("internal_error", "qrcode output file missing");
    }
  }

  private async buildQrcodeInfo(): Promise<QrImageInfo> {
    const buffer = await fs.readFile(QR_OUTPUT_PATH);
    const dimensions = this.readPngDimensions(buffer);
    const stat = await fs.stat(QR_OUTPUT_PATH);
    if (!stat.isFile() || stat.size <= 0) {
      throw new AppError("internal_error", "qrcode output file missing");
    }
    return {
      local_path: QR_OUTPUT_PATH,
      mime_type: "image/png",
      width: dimensions.width,
      height: dimensions.height,
      size_bytes: stat.size,
      source: "local_file"
    };
  }

  private readPngDimensions(buffer: Buffer): { width: number; height: number } {
    if (buffer.length < 24) {
      throw new AppError("internal_error", "qrcode png is too small");
    }

    const pngSignature = "89504e470d0a1a0a";
    if (buffer.subarray(0, 8).toString("hex") !== pngSignature) {
      throw new AppError("internal_error", "qrcode output is not a png image");
    }

    const ihdrChunkType = buffer.subarray(12, 16).toString("ascii");
    if (ihdrChunkType !== "IHDR") {
      throw new AppError("internal_error", "qrcode png ihdr chunk missing");
    }

    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (width <= 0 || height <= 0) {
      throw new AppError("internal_error", "qrcode png dimensions are invalid");
    }
    return { width, height };
  }
}
