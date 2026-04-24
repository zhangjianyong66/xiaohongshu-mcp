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
- Browser: launched per tool call and closed after execution
- Session: encrypted local persistence to avoid frequent re-login

## Environment variables

- `XHS_SESSION_ENCRYPTION_KEY` (required): secret used to encrypt session state
- `XHS_DATA_DIR` (optional): default `~/.xiaohongshu-mcp-ts-lite`
- `XHS_SESSION_FILE` (optional): default `${XHS_DATA_DIR}/session.enc`
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
