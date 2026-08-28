# Agent setup

Search Toolkit runs as one local STDIO MCP server. The same built server can be used by Codex, Claude Code, Cursor, VS Code, Gemini CLI, and any other STDIO-capable MCP client.

Build once:

```powershell
npm install
npm run build
```

The Windows default is `%USERPROFILE%/.config/search-toolkit/providers.json`, deliberately outside `AppData/Local` so packaged apps and ordinary CLI processes resolve the same physical file. Pass `--config` explicitly in agent configuration for auditable cross-client setup.

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

Copy `skills/search-toolkit/` into the agent's supported skill directory. The skill is deliberately provider-aware: it routes exact/code discovery to Exa, current agent research to Tavily, general search to Querit, official/concise lookup to Serper, independent web/news and LLM-ready grounding to Brave, unified Web/News highlights to You.com, semantic objective search to Parallel, sourced research to LinkUp, extraction to Firecrawl, and Doubao only on explicit request.
