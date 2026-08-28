# Agent setup

Search Toolkit runs as one local STDIO MCP server. The same built server can be used by Codex, Claude Code, Cursor, VS Code, Gemini CLI, and any other STDIO-capable MCP client.

Build once:

```powershell
npm install
npm run build
```

Set `SEARCH_TOOLKIT_CONFIG` only when the config is not in the default platform path.

## Codex

```powershell
codex mcp add searchToolkit -- node E:/Script/Services/search-toolkit/dist/src/mcp-server.js
```

Equivalent `~/.codex/config.toml`:

```toml
[mcp_servers.searchToolkit]
command = "node"
args = ["E:/Script/Services/search-toolkit/dist/src/mcp-server.js"]
startup_timeout_sec = 60
tool_timeout_sec = 120
enabled = true
```

## Claude Code

```powershell
claude mcp add searchToolkit -- node E:/Script/Services/search-toolkit/dist/src/mcp-server.js
```

## Cursor or Claude Desktop

```json
{
  "mcpServers": {
    "searchToolkit": {
      "command": "node",
      "args": ["E:/Script/Services/search-toolkit/dist/src/mcp-server.js"]
    }
  }
}
```

## Gemini CLI

Add an STDIO MCP server whose command is `node` and whose only argument is the absolute path to `dist/src/mcp-server.js`.

## Agent Skill

Copy `skills/search-toolkit/` into the agent's supported skill directory. The skill is deliberately provider-aware: it routes exact/code discovery to Exa, current agent research to Tavily, general search to Querit, official/concise lookup to Serper, web/news to Brave, sourced research to LinkUp, extraction to Firecrawl, and Doubao only on explicit request.
