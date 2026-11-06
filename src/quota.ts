import { maskKey, type RotationStore } from "./rotation.js";
import { slotTier } from "./keys.js";
import { redact } from "./provenance.js";
import type { ProviderConfig } from "./types.js";

/** A provider's own balance or usage endpoint. Reading it costs no credits. */
interface QuotaEndpoint {
  url: string;
  headers(key: string): Record<string, string>;
  /** What is left, in the provider's own unit (credits, dollars, cents); undefined when the answer does not say. */
  remaining(data: unknown): number | undefined;
}

function numberAt(data: unknown, path: string): number | undefined {
  let value: unknown = data;
  for (const part of path.split(".")) value = value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
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

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

export const QUOTA_ENDPOINTS: Record<string, QuotaEndpoint> = {
  serper: { url: "https://google.serper.dev/account", headers: (key) => ({ "X-API-KEY": key }), remaining: (data) => numberAt(data, "balance") },
  tavily: { url: "https://api.tavily.com/usage", headers: bearer, remaining: tavilyRemaining },
  firecrawl: { url: "https://api.firecrawl.dev/v2/team/credit-usage", headers: bearer, remaining: (data) => numberAt(data, "data.remainingCredits") },
  linkup: { url: "https://api.linkup.so/v1/credits/balance", headers: bearer, remaining: (data) => numberAt(data, "balance") },
  you: { url: "https://api.you.com/v1/billing/account_balance", headers: (key) => ({ "X-API-Key": key }), remaining: (data) => numberAt(data, "data.attributes.balance") },
  tinyfish: { url: "https://agent.tinyfish.ai/v1/wallet", headers: (key) => ({ "X-API-Key": key }), remaining: (data) => numberAt(data, "available_balance") },
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

const QUOTA_FIELD = /balance|remaining|credit|usage|limit|plan|currency|period|reset/i;

/** Keep the fields that say how much is left; drop ids, URLs, and nested noise. */
export function quotaFields(value: unknown, prefix = "", depth = 0, out: Record<string, string | number | boolean> = {}): Record<string, string | number | boolean> {
  if (!value || typeof value !== "object" || depth > 3) return out;
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${name}` : name;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      quotaFields(item, path, depth + 1, out);
    } else if ((typeof item === "number" || typeof item === "string" || typeof item === "boolean") && QUOTA_FIELD.test(path)) {
      if (typeof item === "string" && item.length > 80) continue;
      out[path] = item;
    }
  }
  return out;
}

/**
 * Ask each key's own billing endpoint what is left. One read per key, in order.
 * With a rotation store, each answer is recorded: an empty key is marked
 * exhausted, a refilled one is put back in rotation.
 */
export async function readQuota(name: string, config: ProviderConfig, rotation?: RotationStore, timeoutMs = 15_000): Promise<QuotaRow[]> {
  const endpoint = QUOTA_ENDPOINTS[name];
  if (!endpoint) throw new Error(`${name} has no known balance endpoint (supported: ${Object.keys(QUOTA_ENDPOINTS).join(", ")})`);
  const rows: QuotaRow[] = [];
  for (const [slot, key] of config.keys.entries()) {
    const tier = slotTier(config, slot);
    const label = config.keyMeta?.[slot]?.label;
    const base = { provider: name, slot, masked: maskKey(key), ...(tier ? { tier } : {}), ...(label ? { label } : {}) };
    try {
      const response = await fetch(endpoint.url, {
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
      rotation?.recordQuota(name, key, remaining);
      rows.push({ ...base, ok: true, ...(remaining !== undefined ? { remaining } : {}), quota: quotaFields(parsed) });
    } catch (error) {
      rows.push({ ...base, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return rows;
}
