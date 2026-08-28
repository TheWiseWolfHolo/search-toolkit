# Provider capability map

| Intent | Preferred capability |
| --- | --- |
| General fast lookup | Querit |
| Exact phrase, code, semantic or similar-page discovery | Exa |
| Current news, search-to-extract, research workflow | Tavily |
| Official site and concise Google results | Serper |
| Independent web/news index | Brave |
| Sourced answer and long-running research | LinkUp |
| Scrape, crawl, map, batch and structured extraction | Firecrawl |
| Compact search | Jina |
| Web-agent automation | TinyFish official tools |
| Chinese local web with explicit quota approval | Doubao |
| Web + X-native search and synthesis | Grok |

The MCP server exposes official upstream tool schemas with provider prefixes, such as `exa_web_search_exa` and `tavily_tavily_search`. Tool inventories can change as official MCP servers evolve; inspect the live tool list rather than hard-coding every optional upstream tool in prompts.
