import { slotTier } from "./keys.js";
import { redact } from "./provenance.js";
import { KNOWN_ENDPOINT_SUFFIX, readLimitedText } from "./rest/base.js";
import { keyFingerprint, maskKey, type QuotaUnit, type RotationStore } from "./rotation.js";
import type { ProviderConfig } from "./types.js";

export type { QuotaUnit } from "./rotation.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_QUOTA_RESPONSE_BYTES = 1024 * 1024;
/** Tavily /usage allows 10 requests per 10 minutes; guard repeated non-forced refreshes. */
const TAVILY_MIN_COOLDOWN_MS = 65_000;

/** A provider's own balance or usage endpoint. Reading it costs no credits. */
export interface QuotaEndpoint {
  url: string;
  /** Optional relative path appended to a configured REST baseUrl root. */
  baseUrlPath?: string;
  /** Canonical unit of `remaining` ("credits" | "USD" | "cents"). */
  unit: QuotaUnit;
  headers(key: string, config?: ProviderConfig): Record<string, string>;
  /** What is left, in the provider's own unit (credits, USD, cents); undefined when the answer does not say. */
  remaining(data: unknown): number | undefined;
  /** Optional override of `unit` derived from the response payload (e.g. non-USD DeepSeek wallet). */
  resolveUnit?(data: unknown): QuotaUnit | undefined;
  /** Optional human-friendly display conversion (e.g. cents -> USD, or DeepSeek primary currency). */
  display?(data: unknown, remaining: number): { remaining: number; unit: string } | undefined;
  /** Optional plan allowance for the current billing period. */
  planLimit?(data: unknown): number | undefined;
  /** Optional ISO timestamp for when the current billing period ends/resets. */
  billingPeriodEnd?(data: unknown): string | undefined;
  /** Optional extra flattened fields added to `row.quota` (e.g. DeepSeek per-currency breakdown). */
  extraFields?(data: unknown): Record<string, string | number | boolean> | undefined;
  /** Optional validity check for providers that report failures inside HTTP 200 envelopes. */
  isValid?(data: unknown): boolean;
  /** Optional provider-specific low-balance rule. */
  isLowBalance?(data: unknown, remaining: number): boolean;
  /** When false, a 0 reading is recorded for display without benching the key (e.g. TinyFish $0 wallet with free daily tier). */
  exhaustOnZero?: boolean;
  /** Minimum interval between live reads when `!force`. */
  minCooldownMs?: number;
}

export interface QuotaRow {
  provider: string;
  slot: number;
  masked: string;
  tier?: string;
  label?: string;
  ok: boolean;
  /** The single number the pool acts on: at or below zero the key is exhausted. */
  remaining?: number;
  /** Canonical unit of `remaining` ("credits" | "USD" | "cents"). */
  unit?: QuotaUnit;
  /** Human-friendly converted balance (e.g. You.com cents -> USD, DeepSeek primary currency). */
  displayRemaining?: number;
  /** Human-friendly unit label matching `displayRemaining`. */
  displayUnit?: string;
  /** Plan allowance for the current billing period when reported. */
  planLimit?: number;
  /** ISO timestamp for when the current billing period ends/resets when reported. */
  billingPeriodEnd?: string;
  /** True when remaining balance is below the low-balance warning threshold. */
  lowBalance?: boolean;
  /** True when returned from recent cached state under a cooldown/maxAge guard. */
  cached?: boolean;
  /** Balance, usage, limit, plan, and billing-period fields, flattened to dotted paths. */
  quota?: Record<string, string | number | boolean>;
  error?: string;
}

export interface ReadQuotaOptions {
  timeoutMs?: number;
  maxAgeMs?: number;
  force?: boolean;
}

export interface ReadAllQuotasOptions {
  providers?: string[];
  maxAgeMs?: number;
  force?: boolean;
  timeoutMs?: number;
}

interface CachedQuotaEntry {
  checkedAt: number;
  row: QuotaRow;
}

/** Per-RotationStore in-process cache so cooldown hits preserve full metadata without cross-store bleed. */
const IN_PROCESS_CACHE = new WeakMap<RotationStore, Map<string, CachedQuotaEntry>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function valueAt(data: unknown, path: string): unknown {
  let value: unknown = data;
  for (const part of path.split(".")) {
    value = isRecord(value) ? value[part] : undefined;
  }
  return value;
}

function numberAt(data: unknown, path: string): number | undefined {
  const value = valueAt(data, path);
  if (typeof value === "string" && !value.trim()) return undefined;
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : undefined;
}

function stringAt(data: unknown, path: string): string | undefined {
  const value = valueAt(data, path);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extractErrorMessage(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  if (typeof data.error === "string" && data.error.trim()) return data.error.trim();
  if (isRecord(data.error) && typeof data.error.message === "string" && data.error.message.trim()) {
    return data.error.message.trim();
  }
  if (typeof data.message === "string" && data.message.trim()) return data.message.trim();
  return undefined;
}

/** Tavily: plan monthly allowance left plus PAYGO room, capped by any per-key limit. */
function tavilyRemaining(data: unknown): number | undefined {
  const limit = numberAt(data, "account.plan_limit");
  const used = numberAt(data, "account.plan_usage");
  const keyLimit = numberAt(data, "key.limit");
  const keyUsed = numberAt(data, "key.usage");

  let accountRemaining: number | undefined;
  if (limit !== undefined && used !== undefined) {
    const paygoLimit = numberAt(data, "account.paygo_limit");
    const paygoUsed = numberAt(data, "account.paygo_usage") ?? 0;
    accountRemaining = Math.max(0, limit - used)
      + (paygoLimit !== undefined ? Math.max(0, paygoLimit - paygoUsed) : 0);
  }

  let keyRemaining: number | undefined;
  if (keyLimit !== undefined && keyUsed !== undefined) {
    keyRemaining = Math.max(0, keyLimit - keyUsed);
  }

  if (accountRemaining !== undefined && keyRemaining !== undefined) {
    return Math.min(accountRemaining, keyRemaining);
  }
  return accountRemaining ?? keyRemaining;
}

function tavilyPlanLimit(data: unknown): number | undefined {
  const accountLimit = numberAt(data, "account.plan_limit");
  const keyLimit = numberAt(data, "key.limit");
  if (accountLimit !== undefined && keyLimit !== undefined) return Math.min(accountLimit, keyLimit);
  return accountLimit ?? keyLimit;
}

interface DeepSeekWallet {
  currency: string;
  total: number;
}

interface DeepSeekParsed {
  isAvailable: boolean | undefined;
  wallets: DeepSeekWallet[];
  primary: DeepSeekWallet | undefined;
}

function parseDeepSeek(data: unknown): DeepSeekParsed | undefined {
  if (!isRecord(data)) return undefined;
  const isAvailable = typeof data.is_available === "boolean" ? data.is_available : undefined;
  const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
  const wallets: DeepSeekWallet[] = [];
  for (const info of infos) {
    const total = numberAt(info, "total_balance");
    if (total === undefined) continue;
    const currency = stringAt(info, "currency")?.toUpperCase() || "USD";
    wallets.push({ currency, total: Number(total.toFixed(6)) });
  }
  if (isAvailable === undefined && wallets.length === 0) return undefined;
  const primary = wallets.find((wallet) => wallet.total > 0) ?? wallets[0];
  return { isAvailable, wallets, primary };
}

/** DeepSeek: `is_available: false` means empty; otherwise pick the primary currency wallet without mixing currencies. */
function deepseekRemaining(data: unknown): number | undefined {
  const parsed = parseDeepSeek(data);
  if (!parsed) return undefined;
  if (parsed.isAvailable === false) return 0;
  return parsed.primary?.total;
}

function deepseekExtraFields(data: unknown): Record<string, string | number | boolean> | undefined {
  const parsed = parseDeepSeek(data);
  if (!parsed || parsed.wallets.length === 0) return undefined;
  const fields: Record<string, string | number | boolean> = {
    currencies: parsed.wallets.map((wallet) => `${wallet.currency}:${wallet.total}`).join(", "),
  };
  for (const wallet of parsed.wallets) {
    fields[`balance.${wallet.currency}`] = wallet.total;
  }
  return fields;
}

function deepseekIsLowBalance(data: unknown, remaining: number): boolean {
  const parsed = parseDeepSeek(data);
  if (!parsed || parsed.isAvailable === false || remaining <= 0) return true;
  if (parsed.wallets.length === 0) return remaining < 2;
  return parsed.wallets.every((wallet) => (wallet.currency === "CNY" ? wallet.total < 10 : wallet.total < 2));
}

const bearer = (key: string): Record<string, string> => ({ Authorization: `Bearer ${key}` });

export const QUOTA_ENDPOINTS: Record<string, QuotaEndpoint> = {
  serper: {
    url: "https://google.serper.dev/account",
    baseUrlPath: "/account",
    unit: "credits",
    headers: (key) => ({ "X-API-KEY": key }),
    remaining: (data) => numberAt(data, "balance"),
  },
  tavily: {
    url: "https://api.tavily.com/usage",
    unit: "credits",
    headers: bearer,
    remaining: tavilyRemaining,
    planLimit: tavilyPlanLimit,
    minCooldownMs: TAVILY_MIN_COOLDOWN_MS,
  },
  firecrawl: {
    url: "https://api.firecrawl.dev/v2/team/credit-usage",
    unit: "credits",
    headers: bearer,
    isValid: (data) => !isRecord(data) || data.success !== false,
    remaining: (data) => (isRecord(data) && data.success === false ? undefined : numberAt(data, "data.remainingCredits")),
    planLimit: (data) => numberAt(data, "data.planCredits"),
    billingPeriodEnd: (data) => stringAt(data, "data.billingPeriodEnd"),
  },
  linkup: {
    url: "https://api.linkup.so/v1/credits/balance",
    unit: "USD",
    headers: bearer,
    remaining: (data) => numberAt(data, "balance"),
  },
  you: {
    url: "https://api.you.com/v1/billing/account_balance",
    unit: "cents",
    headers: (key) => ({ "X-API-Key": key }),
    remaining: (data) => numberAt(data, "data.attributes.balance"),
    display: (_data, rem) => ({ remaining: Number((rem / 100).toFixed(2)), unit: "USD" }),
  },
  tinyfish: {
    url: "https://agent.tinyfish.ai/v1/wallet",
    unit: "USD",
    headers: (key) => ({ "X-API-Key": key }),
    remaining: (data) => numberAt(data, "available_balance"),
    display: (data, rem) => {
      const currency = stringAt(data, "currency")?.toUpperCase();
      return currency && currency !== "USD" ? { remaining: rem, unit: currency } : undefined;
    },
    exhaustOnZero: false,
  },
  deepseek: {
    url: "https://api.deepseek.com/user/balance",
    baseUrlPath: "/user/balance",
    unit: "USD",
    headers: bearer,
    remaining: deepseekRemaining,
    resolveUnit: (data) => {
      const currency = parseDeepSeek(data)?.primary?.currency;
      return currency === "USD" || currency === "CNY" ? currency : undefined;
    },
    display: (data, rem) => {
      const currency = parseDeepSeek(data)?.primary?.currency;
      return currency ? { remaining: rem, unit: currency } : undefined;
    },
    extraFields: deepseekExtraFields,
    isLowBalance: deepseekIsLowBalance,
  },
  vercel_gateway: {
    url: "https://ai-gateway.vercel.sh/v1/credits",
    baseUrlPath: "/v1/credits",
    unit: "USD",
    headers: (key, config) => ({
      Authorization: `Bearer ${key}`,
      "ai-gateway-auth-method": config?.options?.authMethod === "oidc" ? "oidc" : "api-key",
    }),
    remaining: (data) => numberAt(data, "balance"),
    // A $0 credit balance still allows $0 promo tools such as vercel_parallel_fast.
    exhaustOnZero: false,
  },
};

const QUOTA_FIELD = /balance|remaining|credit|usage|limit|plan|currency|period|reset|available|used/i;
const NOISY_QUOTA_CONTAINER = /(?:^|\.)(?:rates|meters|pricing|tiers|prices)(?:\.|$)/i;
const UNRESOLVED_SECRET_REF = /^(?:env|file):/i;

/** Keep the fields that say how much is left; drop ids, URLs, pricing catalogs, and nested noise. */
export function quotaFields(
  value: unknown,
  prefix = "",
  depth = 0,
  out: Record<string, string | number | boolean> = {},
): Record<string, string | number | boolean> {
  if (!value || typeof value !== "object" || depth > 3) return out;
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${name}` : name;
    if (NOISY_QUOTA_CONTAINER.test(path)) continue;
    if (Array.isArray(item)) {
      // Only descend into balance/quota arrays (e.g. DeepSeek `balance_infos`), not meter/rate catalogs.
      if (!QUOTA_FIELD.test(path)) continue;
      item.slice(0, 4).forEach((entry, index) => {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          quotaFields(entry, `${path}.${index}`, depth + 1, out);
        }
      });
    } else if (item && typeof item === "object") {
      quotaFields(item, path, depth + 1, out);
    } else if ((typeof item === "number" || typeof item === "string" || typeof item === "boolean") && QUOTA_FIELD.test(path)) {
      if (typeof item === "string") {
        if (item.length > 80) continue;
        out[path] = redact(item);
      } else {
        out[path] = item;
      }
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

function quotaUrl(endpoint: QuotaEndpoint, config: ProviderConfig): string {
  if (endpoint.baseUrlPath && config.integration.kind === "rest" && config.integration.baseUrl) {
    const root = config.integration.baseUrl.replace(/\/+$/, "").replace(KNOWN_ENDPOINT_SUFFIX, "");
    return `${root}${endpoint.baseUrlPath}`;
  }
  return endpoint.url;
}

function computeLowBalance(
  remaining: number,
  unit: QuotaUnit | undefined,
  planLimit: number | undefined,
  displayRemaining: number | undefined,
  displayUnit: string | undefined,
): boolean {
  if (remaining <= 0) return true;
  if (planLimit !== undefined && planLimit > 0) {
    return remaining < planLimit * 0.1;
  }
  if (displayUnit === "CNY" && displayRemaining !== undefined) {
    return displayRemaining < 10;
  }
  if (displayUnit === "USD" && displayRemaining !== undefined) {
    return displayRemaining < 2;
  }
  if (unit === "CNY") return remaining < 10;
  if (unit === "USD") return remaining < 2;
  if (unit === "cents") return remaining < 200;
  return remaining < 200;
}

interface DbQuotaSnapshot {
  quota_remaining: number | null;
  quota_checked_at: number | null;
  quota_unit: QuotaUnit | null;
}

function parseQuotaUnit(value: unknown): QuotaUnit | null {
  return value === "credits" || value === "USD" || value === "cents" || value === "CNY" ? value : null;
}

function readDbQuotaSnapshots(rotation: RotationStore | undefined, provider: string): Map<string, DbQuotaSnapshot> {
  const snapshots = new Map<string, DbQuotaSnapshot>();
  if (!rotation || typeof rotation.database !== "function") return snapshots;
  try {
    const rows = rotation
      .database()
      .prepare("SELECT fp, quota_remaining, quota_checked_at, quota_unit FROM key_state WHERE provider = ?")
      .all(provider) as Array<{
      fp: string;
      quota_remaining: number | null;
      quota_checked_at: number | null;
      quota_unit?: unknown;
    }>;
    for (const row of rows) {
      snapshots.set(row.fp, {
        quota_remaining: row.quota_remaining,
        quota_checked_at: row.quota_checked_at,
        quota_unit: parseQuotaUnit(row.quota_unit),
      });
    }
  } catch {
    // Advisory lookup only; fall through to live query.
  }
  return snapshots;
}

function memCacheFor(rotation: RotationStore): Map<string, CachedQuotaEntry> {
  let cache = IN_PROCESS_CACHE.get(rotation);
  if (!cache) {
    cache = new Map<string, CachedQuotaEntry>();
    IN_PROCESS_CACHE.set(rotation, cache);
  }
  return cache;
}

function buildCachedRow(
  endpoint: QuotaEndpoint,
  base: { provider: string; slot: number; masked: string; tier?: string; label?: string },
  remaining: number,
  storedUnit?: QuotaUnit | null,
): QuotaRow {
  const unit = storedUnit ?? endpoint.unit;
  const display = endpoint.display?.({}, remaining)
    ?? (unit === "CNY" ? { remaining, unit: "CNY" } : undefined);
  const lowBalance = computeLowBalance(
    remaining,
    unit,
    undefined,
    display?.remaining,
    display?.unit,
  );
  return {
    ...base,
    ok: true,
    cached: true,
    remaining,
    unit,
    ...(display ? { displayRemaining: display.remaining, displayUnit: display.unit } : {}),
    lowBalance,
  };
}

function formatQuotaError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error && error.cause.message && !error.message.includes(error.cause.message)
      ? `: ${error.cause.message}`
      : "";
    return redact(`${error.message}${cause}`).slice(0, 200);
  }
  return redact(String(error)).slice(0, 200);
}

/**
 * Ask each key's own billing endpoint what is left. One read per key, in order.
 * With a rotation store, each answer is recorded: an empty key is marked
 * exhausted (unless the endpoint has a separate free daily tier), a refilled one
 * is put back in rotation.
 */
export async function readQuota(
  name: string,
  config: ProviderConfig,
  rotation?: RotationStore,
  optionsOrTimeout: number | ReadQuotaOptions = DEFAULT_TIMEOUT_MS,
): Promise<QuotaRow[]> {
  if (!config.enabled) {
    return [{
      provider: name,
      slot: 0,
      masked: "disabled",
      ok: false,
      error: "provider is disabled",
    }];
  }
  const endpoint = quotaEndpointFor(name, config);
  if (!endpoint) {
    throw new Error(`${name} has no known balance endpoint (supported: ${Object.keys(QUOTA_ENDPOINTS).join(", ")})`);
  }

  const options: ReadQuotaOptions = typeof optionsOrTimeout === "number"
    ? { timeoutMs: optionsOrTimeout, force: true }
    : optionsOrTimeout;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Direct readQuota(name, cfg, store) defaults to live reads unless force:false or maxAgeMs is explicitly supplied.
  const force = options.force ?? (options.maxAgeMs === undefined);
  const effectiveCooldownMs = force ? 0 : Math.max(options.maxAgeMs ?? 0, endpoint.minCooldownMs ?? 0);

  const url = quotaUrl(endpoint, config);
  const dbSnapshots = effectiveCooldownMs > 0 ? readDbQuotaSnapshots(rotation, name) : undefined;
  const memCache = rotation ? memCacheFor(rotation) : undefined;
  const rows: QuotaRow[] = [];

  for (const [slot, key] of config.keys.entries()) {
    const tier = slotTier(config, slot);
    const label = config.keyMeta?.[slot]?.label;
    if (UNRESOLVED_SECRET_REF.test(key.trim())) {
      rows.push({
        provider: name,
        slot,
        masked: "<unresolved>",
        ...(tier ? { tier } : {}),
        ...(label ? { label } : {}),
        ok: false,
        error: "unresolved secret reference",
      });
      continue;
    }

    const base = {
      provider: name,
      slot,
      masked: maskKey(key),
      ...(tier ? { tier } : {}),
      ...(label ? { label } : {}),
    };

    if (effectiveCooldownMs > 0 && rotation) {
      const fp = keyFingerprint(key);
      const cacheKey = `${name}:${fp}`;
      const now = Date.now();
      const memEntry = memCache?.get(cacheKey);
      if (memEntry && now - memEntry.checkedAt < effectiveCooldownMs) {
        rows.push({ ...memEntry.row, ...base, cached: true });
        continue;
      }
      const dbSnap = dbSnapshots?.get(fp);
      if (
        dbSnap
        && typeof dbSnap.quota_checked_at === "number"
        && now - dbSnap.quota_checked_at < effectiveCooldownMs
        && typeof dbSnap.quota_remaining === "number"
      ) {
        rows.push(buildCachedRow(endpoint, base, dbSnap.quota_remaining, dbSnap.quota_unit));
        continue;
      }
    }

    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", ...endpoint.headers(key, config) },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await readLimitedText(response, MAX_QUOTA_RESPONSE_BYTES);
      if (!response.ok) {
        const safeError = `HTTP ${response.status}: ${redact(text).slice(0, 160)}`;
        if (response.status === 401 || response.status === 402) {
          rotation?.recordQuotaAuthError(name, key, response.status, safeError);
        }
        rows.push({ ...base, ok: false, error: safeError });
        continue;
      }

      const parsed = JSON.parse(text) as unknown;
      if (endpoint.isValid && !endpoint.isValid(parsed)) {
        const detail = extractErrorMessage(parsed) ?? "provider returned unsuccessful quota response";
        rows.push({ ...base, ok: false, error: redact(detail).slice(0, 160) });
        continue;
      }

      const remaining = endpoint.remaining(parsed);
      const fields = { ...quotaFields(parsed), ...(endpoint.extraFields?.(parsed) ?? {}) };
      if (remaining === undefined) {
        rows.push({
          ...base,
          ok: false,
          error: "unexpected quota response schema",
          quota: fields,
        });
        continue;
      }

      const unit = endpoint.resolveUnit ? endpoint.resolveUnit(parsed) : endpoint.unit;
      const display = endpoint.display?.(parsed, remaining);
      const planLimit = endpoint.planLimit?.(parsed);
      const billingPeriodEnd = endpoint.billingPeriodEnd?.(parsed);
      const lowBalance = endpoint.isLowBalance
        ? endpoint.isLowBalance(parsed, remaining)
        : computeLowBalance(remaining, unit, planLimit, display?.remaining, display?.unit);

      rotation?.recordQuota(name, key, remaining, {
        exhaustOnZero: endpoint.exhaustOnZero !== false,
        preserveStatusOnPositive: endpoint.exhaustOnZero === false,
        ...(unit !== undefined ? { unit } : {}),
      });

      const row: QuotaRow = {
        ...base,
        ok: true,
        remaining,
        ...(unit !== undefined ? { unit } : {}),
        ...(display ? { displayRemaining: display.remaining, displayUnit: display.unit } : {}),
        ...(planLimit !== undefined ? { planLimit } : {}),
        ...(billingPeriodEnd !== undefined ? { billingPeriodEnd } : {}),
        lowBalance,
        quota: fields,
      };
      memCache?.set(`${name}:${keyFingerprint(key)}`, { checkedAt: Date.now(), row });
      rows.push(row);
    } catch (error) {
      rows.push({
        ...base,
        ok: false,
        error: formatQuotaError(error),
      });
    }
  }
  return rows;
}

/**
 * Query multiple providers' billing APIs concurrently (keeping each provider's
 * keys sequential). Disabled providers are rejected safely without leaking
 * unresolved secret references, and per-provider cooldowns (such as Tavily's
 * 65s guard) are enforced unless `force: true` is passed.
 */
export async function readAllQuotas(
  configs: Record<string, ProviderConfig>,
  rotation: RotationStore,
  options: ReadAllQuotasOptions = {},
): Promise<QuotaRow[]> {
  const requested = options.providers !== undefined
    ? Array.from(new Set(options.providers))
    : Object.entries(configs)
        .filter(([provider, config]) => config.enabled && Boolean(quotaEndpointFor(provider, config)))
        .map(([provider]) => provider);

  const perProviderOptions: ReadQuotaOptions = {
    force: options.force === true,
    ...(options.maxAgeMs !== undefined ? { maxAgeMs: options.maxAgeMs } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  };

  const settled = await Promise.all(
    requested.map(async (provider): Promise<QuotaRow[]> => {
      const config = configs[provider];
      if (!config) {
        return [{
          provider,
          slot: 0,
          masked: "unknown",
          ok: false,
          error: `Unknown provider: ${provider}`,
        }];
      }
      if (!config.enabled) {
        return [{
          provider,
          slot: 0,
          masked: "disabled",
          ok: false,
          error: "provider is disabled",
        }];
      }
      if (!quotaEndpointFor(provider, config)) {
        return [{
          provider,
          slot: 0,
          masked: "unsupported",
          ok: false,
          error: `${provider} has no known balance endpoint (supported: ${Object.keys(QUOTA_ENDPOINTS).join(", ")})`,
        }];
      }
      return readQuota(provider, config, rotation, perProviderOptions);
    }),
  );

  return settled.flat();
}
