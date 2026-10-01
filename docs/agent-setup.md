# Agent setup

Search Toolkit runs as one local STDIO MCP server. The same built server can be used by Codex, Claude Code, Cursor, VS Code, Gemini CLI, and any other STDIO-capable MCP client.

Build once:

```powershell
npm install
npm run build
```

The Windows default config is `%USERPROFILE%/.config/search-toolkit/providers.json`, deliberately outside `AppData/Local` so packaged apps and ordinary CLI processes resolve the same physical file. Pass `--config` explicitly in agent configuration for an auditable cross-client setup.

Add `--profile lean` to the server arguments for a client that loads every tool schema into every conversation (see the README's "Context cost"). The server then lists seven tools instead of about forty.

## Codex

```powershell
codex mcp add searchToolkit -- node E:/Script/Services/search-toolkit/dist/src/mcp-server.js --config C:/Users/you/.config/search-toolkit/providers.json
```

Equivalent `~/.codex/config.toml`:

```toml
[mcp_servers.searchToolkit]
command = "node"
args = ["E:/Script/Services/search-toolkit/dist/src/mcp-server.js", "--config", "C:/Users/you/.config/search-toolkit/providers.json"]
startup_timeout_sec = 60
tool_timeout_sec = 120
enabled = true
default_tools_approval_mode = "writes"
```

## Claude Code

```powershell
claude mcp add searchToolkit -- node E:/Script/Services/search-toolkit/dist/src/mcp-server.js --config C:/Users/you/.config/search-toolkit/providers.json
```

## Cursor or Claude Desktop

```json
{
  "mcpServers": {
    "searchToolkit": {
      "command": "node",
      "args": ["E:/Script/Services/search-toolkit/dist/src/mcp-server.js", "--config", "C:/Users/you/.config/search-toolkit/providers.json"]
    }
  }
}
```

## Gemini CLI

Add an STDIO MCP server whose command is `node` and whose only argument is the absolute path to `dist/src/mcp-server.js`.

## Agent Skill

Copy `skills/search-toolkit/` into the agent's supported skill directory. The skill routes ordinary lookup to `search_auto`, known URLs to `fetch_auto`, and images to `search_images`; it reaches for provider tools directly only when a specific capability is needed (Brave LLM Context, Firecrawl crawl and map, LinkUp research, AnySearch verticals, Grok X search). Doubao is used only on explicit request. When the MCP tools are not injected, the skill falls back to the `search-toolkit` CLI, so link it with `npm link` or call `node dist/src/cli.js` by absolute path.
