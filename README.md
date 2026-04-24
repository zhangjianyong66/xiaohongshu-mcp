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
- Browser control: `xiaohongshu-mcp` runs as MCP server and internally connects to `cdp-browser-mcp` as MCP client (stdio)
- Browser bootstrap: on startup call chain, if `cdp_health` fails and `XHS_AUTO_START_CHROME=true`, xhs calls `start_chrome_cdp` automatically and retries
- Login state: sourced from system Chrome profile state, no local encrypted session persistence
- Login QR code: when not logged in, MCP writes QR image to `/tmp/openclaw/xhs-login-qrcode.png` and returns `qr_image` metadata (no base64)
- `search_feeds` / `get_feed_detail`: when not logged in, return `success=false`, `code=login_required`

## Environment variables

- `XHS_CDP_MCP_COMMAND` (optional): default `node`
- `XHS_CDP_MCP_ARGS` (required): JSON string array for child MCP args, e.g. `[
  "/absolute/path/to/cdp-browser-mcp/dist/index.js"
]`
- `XHS_CDP_ENDPOINT` (optional): default `http://127.0.0.1:9222` (passed to child as `CDP_ENDPOINT`)
- `XHS_CDP_PROFILE` (optional): default `system-default` (diagnostics only)
- `XHS_AUTO_START_CHROME` (optional): default `true`
- `XHS_REUSE_PAGE` (optional): default `true`
- `XHS_NAV_TIMEOUT_MS` (optional): default `30000`
- `XHS_SEARCH_MIN_INTERVAL_MS` (optional): default `3000`
- `XHS_DETAIL_MIN_INTERVAL_MS` (optional): default `8000`
- `XHS_COOLDOWN_MS` (optional): default `900000` (15 min)

## Local run

```bash
cd /Users/zhangjianyong/project/z-mcp/xiaohongshu-mcp
npm install
npm run check
npm run dev
```

## MCP config example

```json
{
  "mcpServers": {
    "xiaohongshu-lite": {
      "command": "node",
      "args": ["/absolute/path/to/xiaohongshu-mcp/dist/index.js"],
      "env": {
        "XHS_CDP_MCP_COMMAND": "node",
        "XHS_CDP_MCP_ARGS": "[\"/absolute/path/to/cdp-browser-mcp/dist/index.js\"]",
        "XHS_CDP_ENDPOINT": "http://127.0.0.1:9222"
      }
    }
  }
}
```
