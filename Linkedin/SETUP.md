# LinkedIn MCP Server — Setup & Run Guide

## Prerequisites

| Requirement | Version | Check |
|-------------|---------|-------|
| Node.js | >= 18.0.0 | `node --version` |
| npm | >= 8 (comes with Node) | `npm --version` |

Install Node.js from [nodejs.org](https://nodejs.org) if not already installed.

---

## 1. Install Dependencies

Open a terminal in the project folder and run:

```powershell
cd d:\linkedin\linkedin-mcp-main
npm install
```

---

## 2. Configure Environment Variables

The project uses a `.env` file for configuration. One already exists at the root. Open it and fill in your credentials:

```env
# LinkedIn OAuth App credentials (from LinkedIn Developer Portal)
LINKEDIN_CLIENT_ID=your_client_id_here
LINKEDIN_CLIENT_SECRET=your_client_secret_here
LINKEDIN_REDIRECT_URI=http://localhost:50001/callback

# OR — paste a static access token directly (skips OAuth flow)
LINKEDIN_ACCESS_TOKEN=

# Server settings (defaults shown — change only if needed)
LINKEDIN_MCP_PORT=5051
LINKEDIN_MCP_HOST=127.0.0.1

# OAuth callback port
PORT=50001

# Logging level: debug | info | warn | error
LOG_LEVEL=info
```

### Getting LinkedIn Credentials

1. Go to [LinkedIn Developer Portal](https://www.linkedin.com/developers/apps)
2. Create a new app or open an existing one
3. Under **Auth** tab, copy the **Client ID** and **Client Secret**
4. Add `http://localhost:50001/callback` to the **Authorized Redirect URLs**
5. Enable the required OAuth scopes: `r_liteprofile`, `r_emailaddress`, `w_member_social`

---

## 3. Build the Project

Compile TypeScript to JavaScript (required before running in production mode):

```powershell
npm run build
```

---

## 4. Run the Server

### Option A — HTTP Mode (recommended for MCP clients, Claude Desktop, Cursor)

```powershell
npm run start:http
```

Server starts at `http://127.0.0.1:5051`

### Option B — Development Mode (auto-reloads on file changes)

```powershell
npm run dev
```

### Option C — CLI / stdio Mode (for direct MCP protocol over stdin/stdout)

```powershell
npm start
```

---

## 5. Verify the Server is Running

### Health Check (use this — not `/mcp`)

Open your browser or run in PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:5051/health
```

Expected response:
```json
{ "status": "ok", "tools": 8 }
```

### Why `http://127.0.0.1:5051/mcp` shows nothing in the browser

The `/mcp` endpoint only accepts `POST` requests (JSON-RPC 2.0 protocol). Opening it in a browser sends a `GET` request, which returns a `404` empty response — this is correct behaviour, not an error.

| URL | Method | Purpose |
|-----|--------|---------|
| `/health` | GET | Check if server is running |
| `/mcp` | POST only | MCP JSON-RPC tool calls |

To test the MCP endpoint manually:

```powershell
Invoke-RestMethod -Method POST http://127.0.0.1:5051/mcp `
  -ContentType "application/json" `
  -Headers @{ "Authorization" = "Bearer YOUR_ACCESS_TOKEN" } `
  -Body '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

---

## 6. Connect to Claude Desktop

Add this to your Claude Desktop config file (`%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "linkedin": {
      "command": "node",
      "args": ["d:/linkedin/linkedin-mcp-main/dist/http-main.js"],
      "env": {
        "LINKEDIN_CLIENT_ID": "your_client_id",
        "LINKEDIN_CLIENT_SECRET": "your_client_secret",
        "LINKEDIN_ACCESS_TOKEN": "your_access_token"
      }
    }
  }
}
```

Or use the HTTP transport (if your MCP client supports it):

```
MCP Server URL: http://127.0.0.1:5051/mcp
Authorization:  Bearer YOUR_ACCESS_TOKEN
```

---

## 7. Available Tools (8 active)

| Tool | Description |
|------|-------------|
| `get_linkedin_profile` | Fetch your LinkedIn profile |
| `get_linkedin_posts` | Get your recent posts |
| `get_linkedin_connections` | List your connections |
| `share_linkedin_post` | Publish a new post |
| `search_linkedin_people` | Search for people by keyword |
| `get_linkedin_connection_size` | Get total first-degree connection count |
| `delete_linkedin_post` | Permanently delete a post |
| `update_linkedin_post` | Edit a published post |

---

## 8. All npm Scripts

| Command | Description |
|---------|-------------|
| `npm install` | Install dependencies |
| `npm run build` | Compile TypeScript → `dist/` |
| `npm run dev` | Run in dev mode (tsx, stdio) |
| `npm start` | Run compiled CLI (stdio mode) |
| `npm run start:http` | Run HTTP server on port 5051 |
| `npm test` | Run test suite (67 tests) |
| `npm run lint` | Run ESLint |
| `npm run type-check` | TypeScript type checking |

---

## 9. Troubleshooting

### Server won't start — "LINKEDIN_ACCESS_TOKEN required"
- Either set `LINKEDIN_ACCESS_TOKEN` in `.env`, or provide `LINKEDIN_CLIENT_ID` + `LINKEDIN_CLIENT_SECRET` for OAuth

### Port 5051 already in use
```powershell
# Find what's using port 5051
netstat -ano | findstr :5051
# Kill it by PID
taskkill /PID <pid> /F
```
Or change the port in `.env`: `LINKEDIN_MCP_PORT=5052`

### `node --version` shows < 18
Download Node.js 18+ from [nodejs.org](https://nodejs.org)

### `npm run build` fails with TypeScript errors
```powershell
npm run type-check
```
Fix reported type errors before building.

### OAuth callback fails
Make sure `http://localhost:50001/callback` is listed as an authorized redirect URL in your LinkedIn Developer App settings.
