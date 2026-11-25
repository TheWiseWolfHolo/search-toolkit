import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clearKnownSecretsForTest, registerKnownSecrets } from "../src/provenance.js";
import { QUOTA_ENDPOINTS, quotaFields, readAllQuotas, readQuota } from "../src/quota.js";
import { RotationStore } from "../src/rotation.js";
import type { ProviderConfig } from "../src/types.js";

function restProvider(
  adapter: Extract<ProviderConfig["integration"], { kind: "rest" }>["adapter"],
  overrides: Partial<ProviderConfig> & { baseUrl?: string } = {},
): ProviderConfig {
  const { baseUrl, ...rest } = overrides;
  return {
    enabled: true,
    auto: ["search"],
    keys: ["sk-quota-key-1234567890"],
    integration: { kind: "rest", adapter, ...(baseUrl ? { baseUrl } : {}) },
    ...rest,
  };
}

function mcpProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    enabled: true,
    auto: ["search"],
    keys: ["mcp-quota-key-1234567890"],
    integration: { kind: "remote_mcp", url: "https://example.com/mcp", auth: { kind: "bearer" } },
    ...overrides,
  };
}

test("QUOTA_ENDPOINTS covers all 8 billing providers and enforces redirect: error with expected headers and units", async () => {
  assert.deepEqual(Object.keys(QUOTA_ENDPOINTS).sort(), [
    "deepseek", "firecrawl", "linkup", "serper", "tavily", "tinyfish", "vercel_gateway", "you",
  ]);

  const original = globalThis.fetch;
  const requests: Array<{ url: string; headers: Headers; redirect?: RequestRedirect }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({
      url,
      headers: new Headers(init?.headers),
      ...(init?.redirect ? { redirect: init.redirect } : {}),
    });
    if (url.endsWith("/account")) return Response.json({ balance: 2500 });
    if (url.includes("api.tavily.com/usage")) {
      return Response.json({
        key: { usage: 10, limit: 500 },
        account: { plan_usage: 50, plan_limit: 1000, paygo_usage: 0, paygo_limit: 0 },
      });
    }
    if (url.includes("api.firecrawl.dev/v2/team/credit-usage")) {
      return Response.json({
        success: true,
        data: { remainingCredits: 40, planCredits: 500, billingPeriodEnd: "2026-12-01T00:00:00Z" },
      });
    }
    if (url.includes("api.linkup.so/v1/credits/balance")) return Response.json({ balance: 1.5 });
    if (url.includes("api.you.com/v1/billing/account_balance")) {
      return Response.json({ data: { attributes: { balance: 1234 } } });
    }
    if (url.includes("agent.tinyfish.ai/v1/wallet")) {
      return Response.json({ available_balance: 5, currency: "EUR" });
    }
    if (url.includes("api.deepseek.com/user/balance")) {
      return Response.json({
        is_available: true,
        balance_infos: [{ currency: "CNY", total_balance: "12.50" }, { currency: "USD", total_balance: "3.00" }],
      });
    }
    if (url.includes("ai-gateway.vercel.sh/v1/credits")) {
      return Response.json({ balance: "4.25", total_used: "0.75" });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    // Serper custom baseUrl strips /search -> /account
    const serper = (await readQuota("serper", restProvider("serper", { baseUrl: "https://proxy.example/search" })))[0]!;
    assert.equal(serper.ok, true);
    assert.equal(serper.remaining, 2500);
    assert.equal(serper.unit, "credits");
    assert.equal(serper.lowBalance, false);
    assert.equal(requests.at(-1)?.url, "https://proxy.example/account");
    assert.equal(requests.at(-1)?.headers.get("x-api-key"), "sk-quota-key-1234567890");
    assert.equal(requests.at(-1)?.redirect, "error");

    const tavily = (await readQuota("tavily", mcpProvider()))[0]!;
    assert.equal(tavily.ok, true);
    assert.equal(tavily.remaining, 490);
    assert.equal(tavily.planLimit, 500);
    assert.equal(tavily.unit, "credits");
    assert.equal(requests.at(-1)?.headers.get("authorization"), "Bearer mcp-quota-key-1234567890");

    const firecrawl = (await readQuota("firecrawl", mcpProvider()))[0]!;
    assert.equal(firecrawl.ok, true);
    assert.equal(firecrawl.remaining, 40);
    assert.equal(firecrawl.planLimit, 500);
    assert.equal(firecrawl.billingPeriodEnd, "2026-12-01T00:00:00Z");
    assert.equal(firecrawl.lowBalance, true); // 40 < 10% of 500

    const linkup = (await readQuota("linkup", mcpProvider()))[0]!;
    assert.equal(linkup.ok, true);
    assert.equal(linkup.remaining, 1.5);
    assert.equal(linkup.unit, "USD");
    assert.equal(linkup.lowBalance, true); // < $2

    const you = (await readQuota("you", restProvider("you")))[0]!;
    assert.equal(you.ok, true);
    assert.equal(you.remaining, 1234);
    assert.equal(you.unit, "cents");
    assert.equal(you.displayRemaining, 12.34);
    assert.equal(you.displayUnit, "USD");
    assert.equal(you.lowBalance, false);
    assert.equal(requests.at(-1)?.headers.get("x-api-key"), "sk-quota-key-1234567890");

    const tinyfish = (await readQuota("tinyfish", restProvider("tinyfish")))[0]!;
    assert.equal(tinyfish.ok, true);
    assert.equal(tinyfish.remaining, 5);
    assert.equal(tinyfish.displayRemaining, 5);
    assert.equal(tinyfish.displayUnit, "EUR");

    const deepseek = (await readQuota("deepseek", restProvider("deepseek")))[0]!;
    assert.equal(deepseek.ok, true);
    assert.equal(deepseek.remaining, 12.5);
    assert.equal(deepseek.displayRemaining, 12.5);
    assert.equal(deepseek.displayUnit, "CNY");
    assert.equal(deepseek.lowBalance, false);
    assert.equal(deepseek.quota?.currencies, "CNY:12.5, USD:3");
    assert.equal(deepseek.quota?.["balance.CNY"], 12.5);
    assert.equal(deepseek.quota?.["balance.USD"], 3);

    const vgApiKey = (await readQuota("vercel_gateway", restProvider("vercel_gateway")))[0]!;
    assert.equal(vgApiKey.ok, true);
    assert.equal(vgApiKey.remaining, 4.25);
    assert.equal(vgApiKey.unit, "USD");
    assert.equal(requests.at(-1)?.headers.get("ai-gateway-auth-method"), "api-key");

    await readQuota("vercel_gateway", restProvider("vercel_gateway", { options: { authMethod: "oidc" } }));
    assert.equal(requests.at(-1)?.headers.get("ai-gateway-auth-method"), "oidc");

    assert.ok(requests.every((req) => req.redirect === "error"), "every quota fetch sets redirect: error");
  } finally {
    globalThis.fetch = original;
  }
});

test("Tavily clamps plan overage before adding PAYGO and caps by key.limit", async () => {
  const original = globalThis.fetch;
  let payload: unknown = {};
  globalThis.fetch = async () => Response.json(payload);
  try {
    // Plan overage (1200 > 1000) must clamp plan remaining to 0, leaving full 500 PAYGO room intact.
    payload = {
      account: { plan_limit: 1000, plan_usage: 1200, paygo_limit: 500, paygo_usage: 100 },
    };
    const overage = (await readQuota("tavily", mcpProvider()))[0]!;
    assert.equal(overage.ok, true);
    assert.equal(overage.remaining, 400);

    // Per-key limit lower than account remaining caps the usable remaining credits.
    payload = {
      key: { limit: 150, usage: 120 },
      account: { plan_limit: 1000, plan_usage: 100, paygo_limit: 500, paygo_usage: 0 },
    };
    const capped = (await readQuota("tavily", mcpProvider()))[0]!;
    assert.equal(capped.ok, true);
    assert.equal(capped.remaining, 30);
    assert.equal(capped.planLimit, 150);
  } finally {
    globalThis.fetch = original;
  }
});

test("DeepSeek multi-currency lowBalance and is_available:false handling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "search-toolkit-ds-quota-"));
  const store = new RotationStore(join(dir, "state.db"));
  const original = globalThis.fetch;
  let payload: unknown = {};
  globalThis.fetch = async () => Response.json(payload);
  const cfg = restProvider("deepseek");
  try {
    // Low CNY (<10) but healthy USD (>=2) -> NOT lowBalance.
    payload = {
      is_available: true,
      balance_infos: [{ currency: "CNY", total_balance: "5.00" }, { currency: "USD", total_balance: "4.00" }],
    };
    const mixed = (await readQuota("deepseek", cfg, store))[0]!;
    assert.equal(mixed.remaining, 5);
    assert.equal(mixed.displayUnit, "CNY");
    assert.equal(mixed.lowBalance, false);

    // Both CNY (<10) and USD (<2) low -> lowBalance: true.
    payload = {
      is_available: true,
      balance_infos: [{ currency: "CNY", total_balance: "5.00" }, { currency: "USD", total_balance: "1.00" }],
    };
    const bothLow = (await readQuota("deepseek", cfg, store))[0]!;
    assert.equal(bothLow.lowBalance, true);

    // is_available: false forces remaining=0 and benches the key as exhausted.
    payload = {
      is_available: false,
      balance_infos: [{ currency: "CNY", total_balance: "100.00" }],
    };
    const unavailable = (await readQuota("deepseek", cfg, store))[0]!;
    assert.equal(unavailable.remaining, 0);
    assert.equal(unavailable.lowBalance, true);
    assert.equal(store.status("deepseek", cfg.keys).keys[0]?.status.status, "exhausted");
  } finally {
    globalThis.fetch = original;
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Firecrawl HTTP 200 {success:false}, schema drift, and redirect errors fail cleanly while preserving cached quota", async () => {
  const dir = mkdtempSync(join(tmpdir(), "search-toolkit-fc-quota-"));
  const store = new RotationStore(join(dir, "state.db"));
  const original = globalThis.fetch;
  const cfg = mcpProvider();
  let mode: "ok" | "envelope_fail" | "schema_drift" | "redirect" = "ok";
  globalThis.fetch = async () => {
    if (mode === "ok") {
      return Response.json({ success: true, data: { remainingCredits: 321, planCredits: 500 } });
    }
    if (mode === "envelope_fail") {
      return Response.json({ success: false, error: "invalid team token" });
    }
    if (mode === "schema_drift") {
      return Response.json({ success: true, data: { planName: "pro" } });
    }
    throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
  };
  try {
    const initial = (await readQuota("firecrawl", cfg, store))[0]!;
    assert.equal(initial.ok, true);
    assert.equal(initial.remaining, 321);

    mode = "envelope_fail";
    const envFail = (await readQuota("firecrawl", cfg, store))[0]!;
    assert.equal(envFail.ok, false);
    assert.match(envFail.error ?? "", /invalid team token/);
    assert.equal(store.status("firecrawl", cfg.keys).keys[0]?.status.quota_remaining, 321);

    mode = "schema_drift";
    const drift = (await readQuota("firecrawl", cfg, store))[0]!;
    assert.equal(drift.ok, false);
    assert.match(drift.error ?? "", /unexpected quota response schema/);
    assert.equal(store.status("firecrawl", cfg.keys).keys[0]?.status.quota_remaining, 321);

    mode = "redirect";
    const redir = (await readQuota("firecrawl", cfg, store))[0]!;
    assert.equal(redir.ok, false);
    assert.match(redir.error ?? "", /unexpected redirect/);
    assert.equal(store.status("firecrawl", cfg.keys).keys[0]?.status.quota_remaining, 321);
  } finally {
    globalThis.fetch = original;
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("disabled providers and unresolved env:/file: references never trigger outbound fetch or leak paths", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ balance: 10 });
  };
  try {
    const disabled = await readQuota("serper", restProvider("serper", { enabled: false, keys: ["file:/private/secret.txt"] }));
    assert.equal(disabled.length, 1);
    assert.equal(disabled[0]?.ok, false);
    assert.equal(disabled[0]?.error, "provider is disabled");

    const unresolved = await readQuota("serper", restProvider("serper", {
      enabled: true,
      keys: ["env:MY_UNSET_KEY", "file:/secret/private-dir/api.key"],
    }));
    assert.equal(unresolved.length, 2);
    for (const row of unresolved) {
      assert.equal(row.ok, false);
      assert.equal(row.masked, "<unresolved>");
      assert.equal(row.error, "unresolved secret reference");
      assert.doesNotMatch(JSON.stringify(row), /private-dir|MY_UNSET_KEY/);
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("readAllQuotas runs providers concurrently, enforces Tavily 65s cooldown cache, and reports unknown/disabled/unsupported targets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "search-toolkit-all-quota-"));
  const store = new RotationStore(join(dir, "state.db"));
  const original = globalThis.fetch;

  let serperStarted!: () => void;
  const serperStartedPromise = new Promise<void>((resolve) => { serperStarted = resolve; });
  let linkupStarted!: () => void;
  const linkupStartedPromise = new Promise<void>((resolve) => { linkupStarted = resolve; });
  let concurrentOverlap = false;
  let tavilyFetches = 0;

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("serper.dev")) {
      serperStarted();
      await Promise.race([
        linkupStartedPromise.then(() => { concurrentOverlap = true; }),
        new Promise((r) => setTimeout(r, 500)),
      ]);
      return Response.json({ balance: 999 });
    }
    if (url.includes("linkup.so")) {
      linkupStarted();
      await Promise.race([serperStartedPromise, new Promise((r) => setTimeout(r, 500))]);
      return Response.json({ balance: 15 });
    }
    if (url.includes("tavily.com")) {
      tavilyFetches += 1;
      return Response.json({ account: { plan_limit: 1000, plan_usage: 100 } });
    }
    return new Response("not found", { status: 404 });
  };

  const configs: Record<string, ProviderConfig> = {
    serper: restProvider("serper"),
    linkup: mcpProvider(),
    tavily: mcpProvider(),
    brave: restProvider("brave"),
    deepseek: restProvider("deepseek", { enabled: false }),
  };

  try {
    const first = await readAllQuotas(configs, store);
    assert.equal(concurrentOverlap, true, "serper and linkup quota fetches ran concurrently");
    assert.equal(first.length, 3);
    assert.equal(tavilyFetches, 1);

    // Second non-forced call hits Tavily's 65s cooldown cache without making a new request.
    const second = await readAllQuotas(configs, store, { providers: ["tavily"] });
    assert.equal(tavilyFetches, 1);
    assert.equal(second[0]?.ok, true);
    assert.equal(second[0]?.cached, true);
    assert.equal(second[0]?.remaining, 900);

    // Forced call bypasses Tavily cooldown.
    const forced = await readAllQuotas(configs, store, { providers: ["tavily"], force: true });
    assert.equal(tavilyFetches, 2);
    assert.equal(forced[0]?.cached, undefined);

    // Explicit maxAgeMs reuses cached Serper reading.
    const cachedSerper = await readAllQuotas(configs, store, { providers: ["serper"], maxAgeMs: 60_000 });
    assert.equal(cachedSerper[0]?.cached, true);
    assert.equal(cachedSerper[0]?.remaining, 999);

    // Explicit unknown, disabled, and unsupported providers return clean error rows.
    const errors = await readAllQuotas(configs, store, { providers: ["ghost", "deepseek", "brave"] });
    assert.equal(errors.length, 3);
    assert.equal(errors[0]?.error, "Unknown provider: ghost");
    assert.equal(errors[1]?.error, "provider is disabled");
    assert.match(errors[2]?.error ?? "", /has no known balance endpoint/);
  } finally {
    globalThis.fetch = original;
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("billing 401/402 bench keys via recordQuotaAuthError; recordQuota(0) preserves monotonic backoff and TinyFish preserves exhausted status", async () => {
  const dir = mkdtempSync(join(tmpdir(), "search-toolkit-auth-quota-"));
  const store = new RotationStore(join(dir, "state.db"));
  const original = globalThis.fetch;
  let nextStatus = 401;
  globalThis.fetch = async () => new Response("billing denied", { status: nextStatus });

  const serperCfg = restProvider("serper", { keys: ["key-401-aaaa", "key-402-bbbb"] });
  try {
    nextStatus = 401;
    const rows401 = await readQuota("serper", { ...serperCfg, keys: [serperCfg.keys[0]!] }, store);
    assert.equal(rows401[0]?.ok, false);
    const st401 = store.status("serper", serperCfg.keys).keys[0]!.status;
    assert.equal(st401.status, "disabled");
    assert.equal(st401.last_http_status, 401);

    nextStatus = 402;
    const rows402 = await readQuota("serper", { ...serperCfg, keys: [serperCfg.keys[1]!] }, store);
    assert.equal(rows402[0]?.ok, false);
    const st402 = store.status("serper", serperCfg.keys).keys[1]!.status;
    assert.equal(st402.status, "exhausted");
    assert.equal(st402.last_http_status, 402);

    // Non-monotonic backoff regression guard:
    // recordQuota(0) benches for 6h and advances strikes >= 1, so a subsequent 402 never shrinks cooldown to 30m.
    const keyMono = "key-monotonic-cccc";
    store.recordQuota("linkup", keyMono, 0);
    const afterZero = store.status("linkup", [keyMono]).keys[0]!.status;
    assert.equal(afterZero.status, "exhausted");
    assert.ok(Number(afterZero.strikes ?? 0) >= 1);
    assert.ok(Number(afterZero.cooldown_until ?? 0) - Date.now() > 5 * 60 * 60_000);

    // Simulate cooldown expiry, then hit a live 402: because strikes >= 1, next backoff must be >= 6h (not 30m).
    store.database().prepare("UPDATE key_state SET cooldown_until = 0 WHERE provider = 'linkup'").run();
    const sel = store.select("linkup", [keyMono], true);
    store.record(sel, { ok: false, latencyMs: 10, httpStatus: 402, exhausted: true });
    const afterFollowup402 = store.status("linkup", [keyMono]).keys[0]!.status;
    assert.equal(afterFollowup402.status, "exhausted");
    assert.ok(Number(afterFollowup402.cooldown_until ?? 0) - Date.now() > 5 * 60 * 60_000, "follow-up 402 must not shrink backoff to 30m");

    // preserveStatusOnPositive: TinyFish key benched for free daily cap stays exhausted even when paid wallet > 0.
    const tfCfg = restProvider("tinyfish", { keys: ["key-tf-dddd"] });
    const tfSel = store.select("tinyfish", tfCfg.keys, true);
    store.record(tfSel, { ok: false, latencyMs: 10, httpStatus: 429, exhausted: true });
    assert.equal(store.status("tinyfish", tfCfg.keys).keys[0]?.status.status, "exhausted");

    globalThis.fetch = async () => Response.json({ available_balance: 10 });
    const tfQuota = (await readQuota("tinyfish", tfCfg, store))[0]!;
    assert.equal(tfQuota.ok, true);
    assert.equal(tfQuota.remaining, 10);
    assert.equal(store.status("tinyfish", tfCfg.keys).keys[0]?.status.status, "exhausted");
  } finally {
    globalThis.fetch = original;
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quotaFields suppresses pricing/rate containers, drops oversized strings, and redacts secrets", () => {
  registerKnownSecrets(["secret-quota-token-999"]);
  try {
    const extracted = quotaFields({
      balance: 42,
      plan_name: "pro with secret-quota-token-999",
      long_plan_note: "x".repeat(120),
      rates: { search_credit: 1, limit: 100 },
      meters: [{ balance: 5 }],
      pricing: { tiers: [{ limit: 500 }] },
      unrelated_items: [{ balance: 99 }],
      balance_infos: [{ currency: "USD", total_balance: "42" }],
    });
    assert.equal(extracted.balance, 42);
    assert.equal(extracted.plan_name, "pro with <redacted>");
    assert.equal(extracted.long_plan_note, undefined);
    assert.equal(extracted["rates.search_credit"], undefined);
    assert.equal(extracted["meters.0.balance"], undefined);
    assert.equal(extracted["pricing.tiers.0.limit"], undefined);
    assert.equal(extracted["unrelated_items.0.balance"], undefined);
    assert.equal(extracted["balance_infos.0.currency"], "USD");
    assert.equal(extracted["balance_infos.0.total_balance"], "42");
  } finally {
    clearKnownSecretsForTest();
  }
});

test("post-restart SQLite quota cache restores DeepSeek CNY unit and evaluates <10 CNY threshold", async () => {
  const dir = mkdtempSync(join(tmpdir(), "search-toolkit-cny-restart-"));
  const dbPath = join(dir, "state.db");
  const original = globalThis.fetch;
  const cfgLow = restProvider("deepseek", { keys: ["sk-ds-cny-low-1234"] });
  const cfgOk = restProvider("deepseek", { keys: ["sk-ds-cny-ok-5678"] });

  const store1 = new RotationStore(dbPath);
  try {
    globalThis.fetch = async (input, init) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (String(input).includes("api.deepseek.com/user/balance")) {
        const balance = auth.includes("cny-low") ? "8.50" : "12.50";
        return Response.json({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: balance }] });
      }
      return new Response("not found", { status: 404 });
    };
    const lowLive = (await readQuota("deepseek", cfgLow, store1))[0]!;
    assert.equal(lowLive.unit, "CNY");
    assert.equal(lowLive.displayUnit, "CNY");
    assert.equal(lowLive.lowBalance, true);

    const okLive = (await readQuota("deepseek", cfgOk, store1))[0]!;
    assert.equal(okLive.unit, "CNY");
    assert.equal(okLive.displayUnit, "CNY");
    assert.equal(okLive.lowBalance, false);
  } finally {
    store1.close();
  }

  // Fresh RotationStore simulates process restart with empty IN_PROCESS_CACHE.
  const store2 = new RotationStore(dbPath);
  try {
    globalThis.fetch = async () => {
      throw new Error("cached SQLite snapshot should have served this request without hitting network");
    };
    const cachedLow = (await readAllQuotas({ deepseek: cfgLow }, store2, { providers: ["deepseek"], maxAgeMs: 60_000 }))[0]!;
    assert.equal(cachedLow.ok, true);
    assert.equal(cachedLow.cached, true);
    assert.equal(cachedLow.remaining, 8.5);
    assert.equal(cachedLow.unit, "CNY");
    assert.equal(cachedLow.displayRemaining, 8.5);
    assert.equal(cachedLow.displayUnit, "CNY");
    assert.equal(cachedLow.lowBalance, true, "8.5 CNY must trigger <10 CNY lowBalance threshold, not $2 USD");

    const cachedOk = (await readAllQuotas({ deepseek: cfgOk }, store2, { providers: ["deepseek"], maxAgeMs: 60_000 }))[0]!;
    assert.equal(cachedOk.ok, true);
    assert.equal(cachedOk.cached, true);
    assert.equal(cachedOk.remaining, 12.5);
    assert.equal(cachedOk.unit, "CNY");
    assert.equal(cachedOk.displayUnit, "CNY");
    assert.equal(cachedOk.lowBalance, false);
  } finally {
    globalThis.fetch = original;
    store2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
