# xiaohongshu-mcp ts-lite

A simplified rewrite focused on stability and low platform risk.

## Scope (v1)

- `check_login_status`
- `get_login_qrcode`
- `search_feeds`
- `get_feed_detail`

No write operations (publish/comment/like/favorite).

## Runtime model

- MCP process: stdio server (typically launched on-demand by MCP client)
- Browser: default `cdp` mode reuses existing Chrome over CDP; `launch` mode is fallback
- Session: encrypted local persistence to avoid frequent re-login
- Login QR code: when not logged in, MCP writes QR image to `/tmp/openclaw/xhs-login-qrcode.png` and returns `qr_image` metadata (no base64)
- `search_feeds` / `get_feed_detail`: when not logged in, return `success=false`, `code=login_required`

## Environment variables

- `XHS_SESSION_ENCRYPTION_KEY` (required): secret used to encrypt session state
- `XHS_DATA_DIR` (optional): default `~/.xiaohongshu-mcp-ts-lite`
- `XHS_SESSION_FILE` (optional): default `${XHS_DATA_DIR}/session.enc`
- `XHS_BROWSER_MODE` (optional): `cdp` (default) or `launch`
- `XHS_CDP_ENDPOINT` (optional): default `http://127.0.0.1:9222`
- `XHS_CDP_PROFILE` (optional): default `system-default` (for diagnostics only)
- `XHS_REUSE_PAGE` (optional): default `true` (reuse one tab/page)
- `XHS_CHROME_EXECUTABLE_PATH` (optional): system Chrome path fallback for `launch` mode
- `XHS_HEADLESS` (optional): default `false`
- `XHS_NAV_TIMEOUT_MS` (optional): default `30000`
- `XHS_SEARCH_MIN_INTERVAL_MS` (optional): default `3000`
- `XHS_DETAIL_MIN_INTERVAL_MS` (optional): default `8000`
- `XHS_COOLDOWN_MS` (optional): default `900000` (15 min)

## Local run

```bash
cd ts-lite
npm install
npm run check
npm run dev
```

## Start system Chrome with CDP

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --profile-directory=Default
```

## MCP config example

```json
{
  "mcpServers": {
    "xiaohongshu-lite": {
      "command": "node",
      "args": ["/absolute/path/to/xiaohongshu-mcp/ts-lite/dist/index.js"],
      "env": {
        "XHS_SESSION_ENCRYPTION_KEY": "replace-with-long-random-secret"
      }
    }
  }
}
```
