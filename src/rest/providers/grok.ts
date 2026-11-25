import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { HttpError } from "../../errors.js";
import type { ProviderConfig } from "../../types.js";
import {
  baseUrlOf, cleanHosts, READ_ONLY_OPEN, requestJson, timeoutOf, validateFetchTargetUrl,
  type RestAdapter, type RestAdapterContext,
} from "../base.js";
import { arrayArg, collectCitations, extractResponseText, numberArg, objectRecord, stringArg, stringValue } from "../normalize.js";

const DEFAULT_BASE_URL = "https://api.x.ai/v1/responses";
// grok2api Console runs both native tools on this model in 3-10 s; its reasoning and multi-agent
// siblings take 45-65 s and cost 10-40x more for the same answer. Build models never execute x_search.
const DEFAULT_MODEL = "grok-4.20-0309-non-reasoning";
// Multi-agent runs 4 agents at reasoning effort low/medium and 16 at high/xhigh (docs.x.ai multi-agent).
// Measured on 2026-10-22: 4 agents 45-55 s and $0.1-0.9; 16 agents about 50 s, 120 searches and $2.6.
const MULTI_AGENT_MODEL = "grok-4.20-multi-agent-0309";
const DEPTHS = {
  fast: { effort: "", timeoutMs: 90_000 },
  deep: { effort: "low", timeoutMs: 180_000 },
  max: { effort: "high", timeoutMs: 300_000 },
} as const;
type Depth = keyof typeof DEPTHS;
// Used when the provider config has no systemPrompt. Measured against the earlier generic prompt on
// 16 calls: same accuracy and source count, shorter answers, slightly faster.
const DEFAULT_INSTRUCTIONS = "You are the search backend for another AI agent. Always run your search tools before answering, even when you think you know the answer. Answer only from what the searches found and cite every claim. Give exact dates for events and posts. If nothing relevant is found, say so instead of guessing. Reply in the language of the question. Lead with the direct answer, then the supporting details, and keep it concise.";
const CONCURRENCY_RETRY_MS = 3_000;

async function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  if (signal.aborted) throw signal.reason ?? new Error("Aborted");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * grok2api answers 429 concurrency_limit_exceeded while this key's other calls are still running.
 * That clears in seconds, so wait once and retry, and bench the key only briefly if it persists.
 */
async function postResponses(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const busy = (error: unknown) => error instanceof HttpError && error.status === 429 && /并发|concurrency/i.test(error.message);
  const reqOpts = { timeoutMs, ...(signal ? { signal } : {}) };
  try {
    return await requestJson(url, init, reqOpts);
  } catch (error) {
    if (!busy(error)) throw error;
  }
  await sleepAbortable(CONCURRENCY_RETRY_MS, signal);
  try {
    return await requestJson(url, init, reqOpts);
  } catch (error) {
    if (busy(error)) {
      const retryMs = error instanceof HttpError && error.retryAfterMs !== undefined
        ? Math.min(Math.max(error.retryAfterMs, 5_000), 15_000)
        : 5_000;
      throw new HttpError((error as Error).message, 429, retryMs);
    }
    throw error;
  }
}

function resolveGrokUrl(config: ProviderConfig): string {
  const options = config.options ?? {};
  const rawCustom = typeof options.customUrl === "string" && options.customUrl.trim()
    ? options.customUrl.trim()
    : undefined;
  const configuredBase = config.integration.kind === "rest" && config.integration.baseUrl
    ? config.integration.baseUrl.trim()
    : undefined;
  let chosen: string;
  if (rawCustom) {
    validateFetchTargetUrl(rawCustom, "grok");
    // Respect options.customUrl when integration.baseUrl is unset or still the example default;
    // an explicitly customized integration.baseUrl takes precedence.
    chosen = configuredBase && configuredBase.replace(/\/+$/, "") !== DEFAULT_BASE_URL
      ? configuredBase
      : rawCustom;
  } else {
    chosen = baseUrlOf(config, DEFAULT_BASE_URL);
  }
  const parsed = new URL(chosen);
  const path = parsed.pathname.replace(/\/+$/, "");
  if (path === "" || path === "/v1") {
    parsed.pathname = "/v1/responses";
    return parsed.toString();
  }
  return chosen;
}

function usageLine(depth: Depth, counts: { web: number; x: number; posts: number; hasDetails: boolean }, citationCount: number): string {
  const agents = depth === "max" ? "16 agents" : depth === "deep" ? "4 agents" : "single model";
  if (!counts.hasDetails && citationCount > 0) {
    return `(Grok ${depth}, ${agents}: ${citationCount} cited source${citationCount === 1 ? "" : "s"})`;
  }
  const parts = [`${counts.web} web search${counts.web === 1 ? "" : "es"}`];
  if (counts.x || counts.posts) parts.push(`${counts.x} X search${counts.x === 1 ? "" : "es"} over ${counts.posts} posts`);
  return `(Grok ${depth}, ${agents}: ${parts.join(", ")})`;
}

/** The grok2api Console gateway forwards only dates and the image/video toggles; domain and handle limits are lost. */
function filterHints(
  allowedDomains: readonly string[],
  excludedDomains: readonly string[],
  country: string,
  allowedXHandles: readonly string[],
  excludedXHandles: readonly string[],
  web: boolean,
  x: boolean,
): string {
  const lines: string[] = [];
  if (web) {
    if (allowedDomains.length) lines.push(`Only use web sources from these domains: ${allowedDomains.join(", ")}.`);
    else if (excludedDomains.length) lines.push(`Do not use web sources from these domains: ${excludedDomains.join(", ")}.`);
    if (country) lines.push(`Prefer results relevant to country ${country.toUpperCase()}.`);
  }
  if (x) {
    const handle = (value: string) => `@${value.replace(/^@+/, "")}`;
    if (allowedXHandles.length) lines.push(`Only use X posts from these accounts: ${allowedXHandles.map(handle).join(", ")}.`);
    else if (excludedXHandles.length) lines.push(`Do not use X posts from these accounts: ${excludedXHandles.map(handle).join(", ")}.`);
  }
  return lines.length ? `\n\n${lines.join("\n")}` : "";
}

/** Gateway answers carry numbered `[[1]](url)` markers whose numbers do not survive de-duplication; show the host instead. */
export function cleanAnswer(text: string): string {
  return text.replace(/\[\[\d+\]\]\((https?:\/\/(?:[^()\s]+|\([^()\s]*\))+)\)/g, (_match, url: string) => {
    try {
      return `[${new URL(url).hostname.replace(/^www\./, "")}]`;
    } catch {
      return "";
    }
  });
}

function normalizeCitations(data: Record<string, unknown>): unknown[] {
  const seen = new Set<string>();
  const found: unknown[] = [];
  for (const entry of collectCitations(data)) {
    const citation = typeof entry === "string" ? { url: entry } : objectRecord(entry);
    const url = stringValue(citation.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = stringValue(citation.title);
    found.push(title && !/^\d+$/.test(title) ? { url, title } : { url });
  }
  return found;
}

/** xAI reports tool counts under usage.server_side_tool_usage_details; older gateways omit it. */
function toolCounts(data: Record<string, unknown>): {
  web: number;
  x: number;
  posts: number;
  users: number;
  hasDetails: boolean;
  costUsd?: number;
} {
  const usage = objectRecord(data.usage);
  const rawDetail = usage.server_side_tool_usage_details;
  const hasDetails = Boolean(rawDetail && typeof rawDetail === "object");
  const detail = objectRecord(rawDetail);
  const count = (value: unknown) => (typeof value === "number" ? value : 0);
  const ticks = typeof usage.cost_in_usd_ticks === "number" && Number.isFinite(usage.cost_in_usd_ticks)
    ? Number((usage.cost_in_usd_ticks / 1e10).toFixed(6))
    : undefined;
  return {
    web: count(detail.web_search_calls),
    x: count(detail.x_search_calls),
    posts: count(detail.x_posts_fetched),
    users: count(detail.x_users_fetched),
    hasDetails,
    ...(ticks !== undefined ? { costUsd: ticks } : {}),
  };
}

function grokTool(name: string, title: string, description: string, properties: Record<string, unknown>): Tool {
  return {
    name,
    title,
    description,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "Search question or research prompt" },
        ...properties,
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: READ_ONLY_OPEN,
  };
}

export class GrokAdapter implements RestAdapter {
  tools(): Tool[] {
    const common = {
      maxTurns: { type: "integer", minimum: 1, maximum: 20, default: 3 },
      depth: {
        type: "string",
        enum: ["fast", "deep", "max"],
        default: "fast",
        description: "fast: one model, about 10 s. deep: 4 collaborating agents, about 1 min. max: 16 agents and over 100 searches for multi-faceted research, about 1-5 min and roughly $2-3 per call; use only when the question deserves it",
      },
    };
    const webProps = {
      allowedDomains: { type: "array", maxItems: 5, items: { type: "string" } },
      excludedDomains: { type: "array", maxItems: 5, items: { type: "string" } },
      enableImageSearch: { type: "boolean", default: false },
      enableImageUnderstanding: { type: "boolean", default: false, description: "Allow Grok to inspect images encountered during search" },
      userLocationCountry: { type: "string", minLength: 2, maxLength: 2, description: "ISO alpha-2 country code for localized web search" },
    };
    const xProps = {
      allowedXHandles: { type: "array", maxItems: 20, items: { type: "string" } },
      excludedXHandles: { type: "array", maxItems: 20, items: { type: "string" } },
      fromDate: { type: "string", format: "date" },
      toDate: { type: "string", format: "date" },
      enableImageUnderstanding: { type: "boolean", default: false, description: "Allow Grok to inspect images in X posts" },
      enableVideoUnderstanding: { type: "boolean", default: false, description: "Allow Grok to inspect videos in X posts" },
    };
    return [
      grokTool("grok_web_search", "Grok Web Search", "Grok answers from xAI's native web_search with citations. Set depth=deep or max for multi-agent research.", {
        ...common,
        ...webProps,
      }),
      grokTool("grok_x_search", "Grok X Search", "Grok answers from xAI's native x_search over X posts, users, and threads. Set depth=deep or max for multi-agent research.", {
        ...common,
        ...xProps,
      }),
      grokTool("grok_web_x_search", "Grok Web + X Search", "Grok answers from both web_search and x_search in one request. depth=max runs 16 agents for deep, multi-faceted research.", {
        ...common,
        ...webProps,
        ...xProps,
      }),
    ];
  }

  async call(
    tool: string,
    args: Record<string, unknown>,
    key: string,
    config: ProviderConfig,
    context?: RestAdapterContext,
  ): Promise<unknown> {
    const options = config.options ?? {};
    const base = resolveGrokUrl(config);
    const warnings: string[] = [];
    const tools: Array<Record<string, unknown>> = [];

    const wantsWeb = tool !== "grok_x_search";
    const wantsX = tool !== "grok_web_search";
    const allowedDomains = cleanHosts(arrayArg(args, "allowedDomains"));
    const excludedDomains = cleanHosts(arrayArg(args, "excludedDomains"));
    const country = stringArg(args, "userLocationCountry").trim();
    const stripAt = (handle: string) => handle.replace(/^@+/, "");
    const allowedXHandles = arrayArg(args, "allowedXHandles").map(stripAt).filter(Boolean);
    const excludedXHandles = arrayArg(args, "excludedXHandles").map(stripAt).filter(Boolean);

    if (wantsWeb) {
      const web: Record<string, unknown> = { type: "web_search" };
      if (allowedDomains.length) {
        web.allowed_domains = allowedDomains;
        if (excludedDomains.length) {
          warnings.push("excludedDomains was ignored because Grok does not combine excluded_domains with allowed_domains");
        }
      } else if (excludedDomains.length) {
        web.excluded_domains = excludedDomains;
      }
      if (args.enableImageSearch === true) web.enable_image_search = true;
      if (args.enableImageUnderstanding === true) web.enable_image_understanding = true;
      if (country) web.user_location = { country: country.toUpperCase() };
      tools.push(web);
    }
    if (wantsX) {
      const x: Record<string, unknown> = { type: "x_search" };
      if (allowedXHandles.length) {
        x.allowed_x_handles = allowedXHandles;
        if (excludedXHandles.length) {
          warnings.push("excludedXHandles was ignored because Grok does not combine excluded_x_handles with allowed_x_handles");
        }
      } else if (excludedXHandles.length) {
        x.excluded_x_handles = excludedXHandles;
      }
      if (stringArg(args, "fromDate")) x.from_date = stringArg(args, "fromDate");
      if (stringArg(args, "toDate")) x.to_date = stringArg(args, "toDate");
      if (args.enableImageUnderstanding === true) x.enable_image_understanding = true;
      if (args.enableVideoUnderstanding === true) x.enable_video_understanding = true;
      tools.push(x);
    }
    const depthArg = stringArg(args, "depth");
    const depth: Depth = depthArg === "deep" || depthArg === "max" ? depthArg : "fast";
    const multiAgent = depth !== "fast";
    const model = multiAgent ? String(options.multiAgentModel ?? MULTI_AGENT_MODEL) : String(options.model ?? DEFAULT_MODEL);
    // Without today's date the model reads "this week" as a week in its training year.
    const today = `Today's date is ${new Date().toISOString().slice(0, 10)} (UTC).`;
    const configuredPrompt = typeof options.systemPrompt === "string" ? options.systemPrompt.trim() : "";
    const systemPrompt = `${configuredPrompt || DEFAULT_INSTRUCTIONS}\n${today}`;
    const body: Record<string, unknown> = {
      model,
      instructions: systemPrompt,
      input: [{
        role: "user",
        content: stringArg(args, "query")
          + filterHints(allowedDomains, excludedDomains, country, allowedXHandles, excludedXHandles, wantsWeb, wantsX),
      }],
      tools,
      max_turns: numberArg(args, "maxTurns", 3),
    };
    const configuredEffort = typeof options.reasoningEffort === "string" ? options.reasoningEffort.trim() : "";
    const isNonReasoning = /non-reasoning/i.test(model);
    const effort = multiAgent
      ? DEPTHS[depth].effort
      : isNonReasoning
        ? ""
        : (configuredEffort || (model.startsWith("grok-4.7") ? "low" : ""));
    if (effort) body.reasoning = { effort };
    const data = await postResponses(base, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, timeoutOf(config, DEPTHS[depth].timeoutMs), context?.signal);
    const counts = toolCounts(data);
    const citations = normalizeCitations(data);
    const notes: string[] = [];
    // Only stamp the unsourced warning when the gateway reported tool counts (or returned no citations at all).
    if (counts.hasDetails || citations.length === 0) {
      if (wantsWeb && counts.web === 0) notes.push("no web search was run");
      if (wantsX && counts.x === 0) notes.push("no X search was run");
    }
    const completelyUnsourced = notes.length > 0 && (
      (tool === "grok_web_search" && counts.web === 0)
      || (tool === "grok_x_search" && counts.x === 0)
      || (tool === "grok_web_x_search" && counts.web === 0 && counts.x === 0)
    );
    const prefix = completelyUnsourced
      ? `[Grok ${notes.join(" and ")}; treat this answer as unsourced model knowledge.]\n`
      : notes.length
        ? `(Note: ${notes.join(" and ")}; answer is grounded in the remaining search tool.)\n`
        : "";
    const answer = cleanAnswer(extractResponseText(data));
    return {
      text: `${prefix}${answer}\n\n${usageLine(depth, counts, citations.length)}`,
      citations,
      depth,
      model: data.model ?? body.model,
      toolUsage: {
        webSearches: counts.web,
        xSearches: counts.x,
        xPosts: counts.posts,
        ...(counts.users > 0 ? { xUsers: counts.users } : {}),
      },
      ...(counts.costUsd !== undefined ? { costUsd: counts.costUsd } : {}),
      ...(warnings.length ? { warnings } : {}),
      usage: data.usage,
      responseId: data.id,
    };
  }
}
