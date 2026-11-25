# Agent setup

Search Toolkit runs as a local STDIO MCP server (`dist/src/mcp-server.js`) or a Streamable HTTP MCP server (`dist/src/http-server.js`, supporting both stateful sessions and stateless mode via `SEARCH_TOOLKIT_HTTP_STATELESS=1`). The same server works with Antigravity CLI, Claude Code, Codex, Cursor, VS Code, Gemini CLI, and other MCP clients.

Build once:

```powershell
npm install
npm run build
```

The Windows default config is `%USERPROFILE%/.config/search-toolkit/providers.json`, deliberately outside `AppData/Local` so packaged apps and ordinary CLI processes resolve the same physical file. Pass `--config` explicitly in agent configuration for an auditable cross-client setup. Keys may use `"env:VAR_NAME"` or `"file:/path/to/secret"` indirection instead of plaintext, and `direct_markdown` (`Accept: text/markdown`) requires no keys.

Add `--profile curated` (unified + specialist tools + gateway) or `--profile lean` (7 tools total, including `provider_tools` / `provider_call`) to the server arguments, or set `profile` per HTTP token, for clients that load every tool schema into every conversation (see the README's "Context cost").

## Local Shared Streamable HTTP Daemon (Recommended for Multi-Client Setups)

Running one stateless loopback HTTP server avoids spawning duplicate STDIO processes across clients and lets each client token choose its own `profile`:

```powershell
$env:SEARCH_TOOLKIT_HTTP_STATELESS = "1"
$env:SEARCH_TOOLKIT_HTTP_TOKENS_FILE = "D:/ProgramData/SearchToolkit/tokens.json"
node "D:/Program Files/SearchToolkit/dist/src/http-server.js" --config C:/Users/you/.config/search-toolkit/providers.json
```

Example `tokens.json` (store SHA-256 hex hashes only):

```json
[
  { "hash": "<owner-full-sha256>", "role": "owner", "profile": "full" },
  { "hash": "<codex-lean-sha256>", "role": "client", "profile": "lean" }
]
```

Point any Streamable HTTP MCP client (including Antigravity CLI, Claude Code, Codex, or remote clients over HTTPS) to `http://127.0.0.1:18473/mcp` with `Authorization: Bearer <token>`. On loopback listeners where `SEARCH_TOOLKIT_HTTP_ALLOWED_HOSTS` is unset or contains only loopback hosts, owner tokens can trigger zero-downtime config reloads via `POST /admin/reload`.

## Antigravity CLI (`agy`)

Register either the shared local Streamable HTTP endpoint (preferred) or a STDIO entry in `~/.gemini/antigravity-cli/mcp_config.json`:

```json
{
  "mcpServers": {
    "searchToolkit": {
      "serverUrl": "http://127.0.0.1:18473/mcp",
      "headers": {
        "Authorization": "Bearer ${SEARCH_TOOLKIT_TOKEN}"
      }
    }
  }
}
```

## Codex

STDIO:

```powershell
codex mcp add searchToolkit -- node C:/path/to/search-toolkit/dist/src/mcp-server.js --config C:/Users/you/.config/search-toolkit/providers.json --profile lean
```

Equivalent `~/.codex/config.toml`:

```toml
[mcp_servers.searchToolkit]
command = "node"
args = ["C:/path/to/search-toolkit/dist/src/mcp-server.js", "--config", "C:/Users/you/.config/search-toolkit/providers.json", "--profile", "lean"]
startup_timeout_sec = 60
tool_timeout_sec = 120
enabled = true
default_tools_approval_mode = "writes"
```

## Claude Code

```powershell
claude mcp add searchToolkit --scope user -- node C:/path/to/search-toolkit/dist/src/mcp-server.js --config C:/Users/you/.config/search-toolkit/providers.json
```

## Cursor or Claude Desktop

```json
{
  "mcpServers": {
    "searchToolkit": {
      "command": "node",
      "args": ["C:/path/to/search-toolkit/dist/src/mcp-server.js", "--config", "C:/Users/you/.config/search-toolkit/providers.json"]
    }
  }
}
```

## Gemini CLI

Add an STDIO MCP server running `node` with `dist/src/mcp-server.js`, passing `--config <path>` explicitly and optionally `--profile curated` or `--profile lean` (same `args` array as Cursor/Claude Desktop above).

## Agent Skill

Copy `skills/search-toolkit/` into the agent's supported skill directory (for Agent Switch users, update `~/.agent-switch/skills/search-toolkit/` and sync to each client). The skill routes ordinary lookup to `search_auto`, known URLs to `fetch_auto`, and images to `search_images`; it reaches for specialist provider tools directly only when their specific capability is needed (Brave LLM Context, Parallel Extract, You.com Extract, DeepSeek Search/Fetch, Vercel AI Gateway `vercel_parallel_fast`, Direct Markdown, Querit Contents, Serper Scholar, Firecrawl map/crawl, LinkUp research, AnySearch verticals, Grok X search). Doubao is used only on explicit request.

When MCP tools are not injected, the skill falls back to the `search-toolkit` CLI agent commands (`search`, `images`, `fetch`, `tools`, `call`, `status`), so link it with `npm link` or invoke `node dist/src/cli.js` by absolute path. Operator commands (`quota`, `reset`, `config`, `cache-clear`, `migrate-config`, `probe`) are reserved for operators rather than routine agent workflows. See [docs/operator-guide.md](operator-guide.md) for billing endpoints, key rotation tuning, and HTTP token policies.
