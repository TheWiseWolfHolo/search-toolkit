import { maskKey, type RotationStore } from "./rotation.js";
import { slotTier } from "./keys.js";
import { redact } from "./provenance.js";
import type { ProviderConfig } from "./types.js";

/** A provider's own balance or usage endpoint. Reading it costs no credits. */
interface QuotaEndpoint {
  url: string;
  /** Optional relative path appended to a configured REST baseUrl root. */
  baseUrlPath?: string;
  headers(key: string): Record<string, string>;
  /** What is left, in the provider's own unit (credits, dollars, cents); undefined when the answer does not say. */
  remaining(data: unknown): number | undefined;
  /** When false, a 0 reading is recorded for display without benching the key (e.g., TinyFish $0 wallet with free daily tier). */
  exhaustOnZero?: boolean;
}

function numberAt(data: unknown, path: string): number | undefined {
  let value: unknown = data;
  for (const part of path.split(".")) value = value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : undefined;
}

/** Tavily: the plan's monthly allowance left, plus any pay-as-you-go room. */
function tavilyRemaining(data: unknown): number | undefined {
  const limit = numberAt(data, "account.plan_limit");
  const used = numberAt(data, "account.plan_usage");
  if (limit === undefined || used === undefined) return undefined;
  const paygoLimit = numberAt(data, "account.paygo_limit");
  const paygoUsed = numberAt(data, "account.paygo_usage") ?? 0;
  return limit - used + (paygoLimit !== undefined ? Math.max(0, paygoLimit - paygoUsed) : 0);
}

/** DeepSeek: `is_available: false` means empty; otherwise total balance across currency wallets. */
function deepseekRemaining(data: unknown): number | undefined {
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  if (record.is_available === false) return 0;
  const infos = Array.isArray(record.balance_infos) ? record.balance_infos : [];
  let sum = 0;
  let found = false;
  for (const info of infos) {
    const total = numberAt(info, "total_balance");
    if (total !== undefined) {
      sum += total;
      found = true;
    }
  }
  return found ? Number(sum.toFixed(6)) : undefined;
}

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

export const QUOTA_ENDPOINTS: Record<string, QuotaEndpoint> = {
  serper: { url: "https://google.serper.dev/account", baseUrlPath: "/account", headers: (key) => ({ "X-API-KEY": key }), remaining: (data) => numberAt(data, "balance") },
  tavily: { url: "https://api.tavily.com/usage", headers: bearer, remaining: tavilyRemaining },
  firecrawl: { url: "https://api.firecrawl.dev/v2/team/credit-usage", headers: bearer, remaining: (data) => numberAt(data, "data.remainingCredits") },
  linkup: { url: "https://api.linkup.so/v1/credits/balance", headers: bearer, remaining: (data) => numberAt(data, "balance") },
  you: { url: "https://api.you.com/v1/billing/account_balance", headers: (key) => ({ "X-API-Key": key }), remaining: (data) => numberAt(data, "data.attributes.balance") },
  tinyfish: {
    url: "https://agent.tinyfish.ai/v1/wallet",
    headers: (key) => ({ "X-API-Key": key }),
    remaining: (data) => numberAt(data, "available_balance"),
    exhaustOnZero: false,
  },
  deepseek: {
    url: "https://api.deepseek.com/user/balance",
    baseUrlPath: "/user/balance",
    headers: bearer,
    remaining: deepseekRemaining,
  },
  vercel_gateway: {
    url: "https://ai-gateway.vercel.sh/v1/credits",
    baseUrlPath: "/v1/credits",
    headers: bearer,
    remaining: (data) => numberAt(data, "balance"),
    // A $0 credit balance still allows $0 promo tools such as vercel_parallel_fast.
    exhaustOnZero: false,
  },
};

export interface QuotaRow {
  provider: string;
  slot: number;
  masked: string;
  tier?: string;
  label?: string;
  ok: boolean;
  /** The single number the pool acts on: at or below zero the key is exhausted. */
  remaining?: number;
  /** Balance, usage, limit, plan, and billing-period fields, flattened to dotted paths. */
  quota?: Record<string, string | number | boolean>;
  error?: string;
}

const QUOTA_FIELD = /balance|remaining|credit|usage|limit|plan|currency|period|reset|available|used/i;

/** Keep the fields that say how much is left; drop ids, URLs, and nested noise. */
export function quotaFields(value: unknown, prefix = "", depth = 0, out: Record<string, string | number | boolean> = {}): Record<string, string | number | boolean> {
  if (!value || typeof value !== "object" || depth > 3) return out;
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${name}` : name;
    if (Array.isArray(item)) {
      item.slice(0, 4).forEach((entry, index) => {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          quotaFields(entry, `${path}.${index}`, depth + 1, out);
        }
      });
    } else if (item && typeof item === "object") {
      quotaFields(item, path, depth + 1, out);
    } else if ((typeof item === "number" || typeof item === "string" || typeof item === "boolean") && QUOTA_FIELD.test(path)) {
      if (typeof item === "string" && item.length > 80) continue;
      out[path] = item;
    }
  }
  return out;
}

export function quotaEndpointFor(name: string, config?: ProviderConfig): QuotaEndpoint | undefined {
  if (config?.integration.kind === "rest") {
    return QUOTA_ENDPOINTS[config.integration.adapter] ?? QUOTA_ENDPOINTS[name];
  }
  return QUOTA_ENDPOINTS[name];
}

const QUOTA_STRIP_SUFFIX = /\/(?:v1\/(?:search|extract|contents|images\/search|tools\/search|tools\/fetch|responses)|v4\/ai\/language-model|v1)$/i;

function quotaUrl(endpoint: QuotaEndpoint, config: ProviderConfig): string {
  if (endpoint.baseUrlPath && config.integration.kind === "rest" && config.integration.baseUrl) {
    const root = config.integration.baseUrl.replace(/\/+$/, "").replace(QUOTA_STRIP_SUFFIX, "");
    return `${root}${endpoint.baseUrlPath}`;
  }
  return endpoint.url;
}

/**
 * Ask each key's own billing endpoint what is left. One read per key, in order.
 * With a rotation store, each answer is recorded: an empty key is marked
 * exhausted (unless the endpoint has a separate free daily tier), a refilled one
 * is put back in rotation.
 */
export async function readQuota(name: string, config: ProviderConfig, rotation?: RotationStore, timeoutMs = 15_000): Promise<QuotaRow[]> {
  const endpoint = quotaEndpointFor(name, config);
  if (!endpoint) throw new Error(`${name} has no known balance endpoint (supported: ${Object.keys(QUOTA_ENDPOINTS).join(", ")})`);
  const url = quotaUrl(endpoint, config);
  const rows: QuotaRow[] = [];
  for (const [slot, key] of config.keys.entries()) {
    const tier = slotTier(config, slot);
    const label = config.keyMeta?.[slot]?.label;
    const base = { provider: name, slot, masked: maskKey(key), ...(tier ? { tier } : {}), ...(label ? { label } : {}) };
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", ...endpoint.headers(key) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      if (!response.ok) {
        rows.push({ ...base, ok: false, error: `HTTP ${response.status}: ${redact(text).slice(0, 160)}` });
        continue;
      }
      const parsed = JSON.parse(text) as unknown;
      const remaining = endpoint.remaining(parsed);
      rotation?.recordQuota(name, key, remaining, endpoint.exhaustOnZero !== false);
      rows.push({ ...base, ok: true, ...(remaining !== undefined ? { remaining } : {}), quota: quotaFields(parsed) });
    } catch (error) {
      rows.push({ ...base, ok: false, error: redact(error instanceof Error ? error.message : String(error)).slice(0, 200) });
    }
  }
  return rows;
}
