import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ProviderConfig } from "../../types.js";
import { baseUrlOf, requestJson, searchTool, type RestAdapter } from "../base.js";
import { arrayArg, collectCitations, extractResponseText, numberArg, stringArg } from "../normalize.js";

const DEFAULT_MODEL = "grok-4.6";

export class GrokAdapter implements RestAdapter {
  tools(): Tool[] {
    const common = {
      maxTurns: { type: "integer", minimum: 1, maximum: 20, default: 3 },
    };
    return [
      searchTool("grok_web_search", "Grok Web Search", "Use the configured Grok model with xAI's native web_search tool and citations.", {
        ...common,
        allowedDomains: { type: "array", items: { type: "string" } },
        excludedDomains: { type: "array", items: { type: "string" } },
        enableImageSearch: { type: "boolean", default: false },
      }),
      searchTool("grok_x_search", "Grok X Search", "Use the configured Grok model with xAI's native x_search tool for posts, users, and threads.", {
        ...common,
        allowedXHandles: { type: "array", items: { type: "string" } },
        excludedXHandles: { type: "array", items: { type: "string" } },
        fromDate: { type: "string", format: "date" },
        toDate: { type: "string", format: "date" },
      }),
      searchTool("grok_web_x_search", "Grok Web + X Search", "Use both xAI native web_search and x_search in one Responses API request.", common),
    ];
  }

  async call(tool: string, args: Record<string, unknown>, key: string, config: ProviderConfig): Promise<unknown> {
    const options = config.options ?? {};
    const base = baseUrlOf(config, String(options.customUrl ?? "https://api.x.ai/v1/responses"));
    const tools: Array<Record<string, unknown>> = [];
    if (tool !== "grok_x_search") {
      const web: Record<string, unknown> = { type: "web_search" };
      const allowed = arrayArg(args, "allowedDomains");
      const excluded = arrayArg(args, "excludedDomains");
      if (allowed.length) web.allowed_domains = allowed;
      if (excluded.length) web.excluded_domains = excluded;
      if (args.enableImageSearch === true) web.enable_image_search = true;
      tools.push(web);
    }
    if (tool !== "grok_web_search") {
      const x: Record<string, unknown> = { type: "x_search" };
      const allowed = arrayArg(args, "allowedXHandles");
      const excluded = arrayArg(args, "excludedXHandles");
      if (allowed.length) x.allowed_x_handles = allowed;
      if (excluded.length) x.excluded_x_handles = excluded;
      if (stringArg(args, "fromDate")) x.from_date = stringArg(args, "fromDate");
      if (stringArg(args, "toDate")) x.to_date = stringArg(args, "toDate");
      tools.push(x);
    }
    const systemPrompt = typeof options.systemPrompt === "string" ? options.systemPrompt.trim() : "";
    const body: Record<string, unknown> = {
      model: String(options.model ?? DEFAULT_MODEL),
      ...(systemPrompt ? { instructions: systemPrompt } : {}),
      input: [{ role: "user", content: stringArg(args, "query") }],
      tools,
      max_turns: numberArg(args, "maxTurns", 3),
    };
    const effort = String(options.reasoningEffort ?? "").trim();
    if (effort) body.reasoning = { effort };
    const data = await requestJson(base, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, 60_000);
    return {
      text: extractResponseText(data),
      citations: collectCitations(data),
      usage: data.usage,
      serverSideToolUsage: data.server_side_tool_usage,
      responseId: data.id,
    };
  }
}
