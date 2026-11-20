import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { migrateConfig, normalizeConfig } from "../src/config.js";
import {
  HttpError, isConnectionFailure, isQuotaExhausted, shouldFailoverProvider, shouldRetryWithNextKey,
  TargetPageError, ToolResultError,
} from "../src/errors.js";
import { focusExcerpt } from "../src/excerpt.js";
import { isUsableFetchText, readableFetchOutput, truncateBody } from "../src/fetching.js";
import { createSearchToolkitHttpApp } from "../src/http.js";
import { redact, registerKnownSecrets } from "../src/provenance.js";
import { readQuota } from "../src/quota.js";
import { BraveAdapter } from "../src/rest/providers/brave.js";
import { DeepSeekAdapter } from "../src/rest/providers/deepseek.js";
import { DirectMarkdownAdapter, isPrivateIp } from "../src/rest/providers/direct-markdown.js";
import { DoubaoAdapter } from "../src/rest/providers/doubao.js";
import { GrokAdapter } from "../src/rest/providers/grok.js";
import { JinaAdapter } from "../src/rest/providers/jina.js";
import { OctenAdapter } from "../src/rest/providers/octen.js";
import { ParallelAdapter } from "../src/rest/providers/parallel.js";
import { QueritAdapter } from "../src/rest/providers/querit.js";
import { TinyfishAdapter } from "../src/rest/providers/tinyfish.js";
import { VercelGatewayAdapter } from "../src/rest/providers/vercel-gateway.js";
import { penaltyFor, RotationStore } from "../src/rotation.js";
import { autoCandidates, imageCandidates } from "../src/routes.js";
import { SearchToolkit } from "../src/toolkit.js";
import type { ProviderConfig } from "../src/types.js";

type RestAdapterName = Extract<ProviderConfig["integration"], { kind: "rest" }>["adapter"];

const REST = (adapter: RestAdapterName, options?: Record<string, unknown>): ProviderConfig => ({
  enabled: true,
  auto: ["search", "fetch"],
  keys: ["sk-test-key-1234567890"],
  integration: { kind: "rest", adapter },
  ...(options ? { options } : {}),
});

test("redact preserves snake_case error codes and tool names while masking real keys", () => {
  registerKnownSecrets(["my_super_secret_custom_key"]);
  assert.equal(redact("error: concurrency_limit_exceeded on exa_web_search_advanced_exa"), "error: concurrency_limit_exceeded on exa_web_search_advanced_exa");
  assert.equal(redact("Bearer sk-proj-abc12345678901234567890"), "Bearer <redacted>");
  assert.equal(redact("https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-1234567890abcdef"), "https://mcp.tavily.com/mcp/?tavilyApiKey=<redacted>");
  assert.equal(redact("leaked my_super_secret_custom_key here"), "leaked <redacted> here");
  assert.equal(redact("token=vck_1234567890abcdef12345678"), "token=<redacted>");
});

test("error classification covers Tavily 432/433/434, TinyFish daily cap, and prevents ToolResultError disconnects", () => {
  assert.equal(penaltyFor(432, 0)?.status, "exhausted");
  assert.equal(penaltyFor(433, 0)?.status, "exhausted");
  assert.equal(penaltyFor(434, 0)?.status, "cooldown");
  assert.equal(shouldRetryWithNextKey(434), true);
  assert.equal(shouldFailoverProvider(new HttpError("HTTP 434: Flex Tier Capacity", 434)), true);
  assert.equal(isQuotaExhausted(new HttpError("HTTP 429: free_allowance_exhausted", 429)), true);
  assert.equal(isQuotaExhausted(new HttpError("HTTP 400: query exceeds your plan's max length", 400)), false);
  assert.equal(isQuotaExhausted(new HttpError("HTTP 429: exceeds your plan's rate limit", 429)), false);
  assert.equal(isConnectionFailure(new ToolResultError("Request terminated by site", [])), false);
});

test("rotation record preserves existing exhausted/cooldown status on non-penalized errors and scopes provider health by capability", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "search-toolkit-rot-fix-"));
  const store = new RotationStore(resolve(dir, "state.db"));
  try {
    const keys = ["key-alpha-123456", "key-bravo-123456"];
    const first = store.select("exa", keys, true);
    store.record(first, { ok: false, latencyMs: 10, httpStatus: 402, exhausted: true });
    assert.equal(store.status("exa", keys).keys[0]?.status.status, "exhausted");
    // A subsequent 503 / planLimit error on that same key must NOT reset it to healthy.
    store.record(first, { ok: false, latencyMs: 10, httpStatus: 503 });
    assert.equal(store.status("exa", keys).keys[0]?.status.status, "exhausted");

    // Fetch failures must not demote Search health.
    store.recordProviderOutcome("deepseek", true, "fetch");
    store.recordProviderOutcome("deepseek", true, "fetch");
    assert.ok((store.providerFailureScores("fetch").get("deepseek") ?? 0) >= 0.5);
    assert.equal(store.providerFailureScores("search").get("deepseek") ?? 0, 0);
    assert.ok((store.providerFailureScores().get("deepseek") ?? 0) >= 0.5);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config resolves env: and file: secret references without inlining secrets during migration", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "search-toolkit-secret-"));
  const secretFile = join(dir, "secret.txt");
  writeFileSync(secretFile, "  file-secret-value-987654  \n");
  process.env.TEST_ST_VERCEL_KEY = "env-secret-value-123456";
  try {
    const raw = {
      version: 2,
      statePath: join(dir, "state.db"),
      providers: {
        vercel_gateway: {
          enabled: true,
          auto: ["search", "fetch"],
          keys: ["env:TEST_ST_VERCEL_KEY", { key: `file:${secretFile}`, label: "backup" }],
          integration: { kind: "rest", adapter: "vercel_gateway" },
        },
        deepseek: {
          enabled: false,
          auto: ["search"],
          keys: ["env:UNSET_DISABLED_KEY_XYZ"],
          integration: { kind: "rest", adapter: "deepseek" },
        },
      },
    };
    const { config, notes } = normalizeConfig(raw);
    assert.deepEqual(notes, []);
    assert.deepEqual(config.providers.vercel_gateway?.keys, ["env-secret-value-123456", "file-secret-value-987654"]);
    const migrated = migrateConfig(raw).document as { providers: { vercel_gateway: { keys: unknown[] } } };
    assert.deepEqual(migrated.providers.vercel_gateway.keys, [
      "env:TEST_ST_VERCEL_KEY",
      { key: `file:${secretFile}`, label: "backup" },
    ]);
  } finally {
    delete process.env.TEST_ST_VERCEL_KEY;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DeepSeek adapter enforces 128-char limit and maps fetch 403/404 to TargetPageError without benching keys", async () => {
  const adapter = new DeepSeekAdapter();
  const original = globalThis.fetch;
  let capturedUrl = "";
  let capturedBody: Record<string, unknown> = {};
  let mode: "search" | "fetch_ok" | "fetch_403" | "fetch_404" = "search";
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (mode === "search") {
      return Response.json({
        results: [{
          title: "DeepSeek Docs",
          url: "https://api-docs.deepseek.com/",
          snippet: "short snippet",
          summary: "Rich DeepSeek summary",
          date: "2026-10-20",
          rerank_score: 0.94,
          authority: 8,
        }],
      });
    }
    if (mode === "fetch_ok") return Response.json({ title: "Docs", content: "## Hello\nClean Markdown body." });
    if (mode === "fetch_403") return new Response('{"error":"blocked by target security policy"}', { status: 403 });
    return new Response('{"error":"cannot extract page"}', { status: 404 });
  };
  try {
    const out = await adapter.call("deepseek_search", {
      query: "DeepSeek API",
      limit: 5,
      includeDomains: ["api-docs.deepseek.com"],
      afterDate: "2026-10-01",
    }, "sk-ds-key", REST("deepseek")) as { items: Array<{ text: string; rerankScore?: number }> };
    assert.equal(capturedUrl, "https://api.deepseek.com/v1/tools/search");
    assert.equal(capturedBody.query, "DeepSeek API site:api-docs.deepseek.com after:2026-10-01");
    assert.equal(out.items[0]?.text, "Rich DeepSeek summary");
    assert.equal(out.items[0]?.rerankScore, 0.94);

    await assert.rejects(
      adapter.call("deepseek_search", { query: "a".repeat(129) }, "sk-ds-key", REST("deepseek")),
      /128-character limit/,
    );

    mode = "fetch_ok";
    const fetched = await adapter.call("deepseek_fetch", { url: "https://api-docs.deepseek.com/" }, "sk-ds-key", REST("deepseek")) as { text: string };
    assert.equal(fetched.text, "# Docs\nURL: https://api-docs.deepseek.com/\n\n## Hello\nClean Markdown body.");

    mode = "fetch_403";
    await assert.rejects(
      adapter.call("deepseek_fetch", { url: "https://blocked.example/" }, "sk-ds-key", REST("deepseek")),
      (err: unknown) => err instanceof TargetPageError && err.pageStatus === 403,
    );

    mode = "fetch_404";
    await assert.rejects(
      adapter.call("deepseek_fetch", { url: "https://spa.example/" }, "sk-ds-key", REST("deepseek")),
      (err: unknown) => err instanceof TargetPageError && err.pageStatus === undefined,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("Vercel AI Gateway adapter speaks v4/ai SSE for deepseek_search, deepseek_fetch, and pinned-fast parallel_search", async () => {
  const adapter = new VercelGatewayAdapter();
  const original = globalThis.fetch;
  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  let nextSse = "";
  globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(nextSse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  const cfg = REST("vercel_gateway", { model: "nvidia/nemotron-3.5-lightning-free", reasoning: "none" });
  try {
    nextSse = [
      `data: ${JSON.stringify({ type: "tool-result", toolName: "deepseek_search", output: { results: [{ title: "V", url: "https://vercel.com", summary: "Vercel summary", date: "2026-11-01" }] } })}`,
      `data: ${JSON.stringify({ type: "finish", finishReason: "stop", providerMetadata: { gateway: { cost: "0.00075", toolCalls: { deepseek_search: 1 } } } })}`,
      "",
    ].join("\n\n");
    const searched = await adapter.call("vercel_deepseek_search", { query: "Vercel DeepSeek", limit: 3 }, "vck_test", cfg) as { items: Array<{ text: string }>; gatewayCost?: string };
    assert.equal(requests[0]?.url, "https://ai-gateway.vercel.sh/v4/ai/language-model");
    assert.equal(requests[0]?.headers.get("ai-gateway-protocol-version"), "0.0.1");
    assert.equal(requests[0]?.headers.get("ai-language-model-specification-version"), "4");
    assert.equal(requests[0]?.headers.get("ai-language-model-id"), "nvidia/nemotron-3.5-lightning-free");
    assert.equal(requests[0]?.body.reasoning, "none");
    assert.equal(searched.items[0]?.text, "Vercel summary");
    assert.equal(searched.gatewayCost, "0.00075");

    nextSse = [
      `data: ${JSON.stringify({ type: "tool-result", toolName: "parallel_search", result: { results: [{ title: "P", url: "https://parallel.ai", excerpts: ["Fast promo hit"] }] } })}`,
      `data: ${JSON.stringify({ type: "finish", finishReason: "stop", providerMetadata: { gateway: { cost: "0" } } })}`,
      "",
    ].join("\n\n");
    const longQuery = "Vercel AI Gateway DeepSeek Search pricing and free tier credits comparison with Parallel Fast mode ".repeat(3);
    const parallel = await adapter.call("vercel_parallel_fast", { query: longQuery, limit: 4 }, "vck_test", cfg) as { items: Array<{ text: string }>; gatewayCost?: string };
    const toolDef = (requests[1]?.body.tools as Array<{ id: string; args: Record<string, unknown> }>)[0];
    assert.equal(toolDef?.id, "gateway.parallel_search");
    assert.equal(toolDef?.args.mode, "fast");
    assert.ok(Number(requests[1]?.body.maxOutputTokens) >= 256, "parallel_search allocates enough output tokens for model-emitted query args");
    assert.equal(parallel.items[0]?.text, "Fast promo hit");
    assert.equal(parallel.gatewayCost, "0");

    nextSse = `data: ${JSON.stringify({ type: "tool-error", error: "403 forbidden target" })}\n\n`;
    await assert.rejects(
      adapter.call("vercel_deepseek_fetch", { url: "https://blocked.example/" }, "vck_test", cfg),
      (err: unknown) => err instanceof TargetPageError,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("DirectMarkdownAdapter negotiates text/markdown, skips HTML, and blocks private/loopback SSRF targets", async () => {
  assert.equal(isPrivateIp("127.0.0.1"), true);
  assert.equal(isPrivateIp("169.254.169.254"), true);
  assert.equal(isPrivateIp("10.0.0.5"), true);
  assert.equal(isPrivateIp("::1"), true);
  assert.equal(isPrivateIp("[::ffff:7f00:1]"), true);
  assert.equal(isPrivateIp("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateIp("64:ff9b::1.2.3.4"), true);
  assert.equal(isPrivateIp("2001:db8::1"), true);
  assert.equal(isPrivateIp("2002:0a00:0001::1"), true);
  assert.equal(isPrivateIp("1.1.1.1"), false);
  assert.equal(isPrivateIp("[2606:4700::6810:85e5]"), false);

  const publicLookup = async () => [{ address: "93.184.216.34" }];
  const adapter = new DirectMarkdownAdapter(publicLookup);
  const cfg: ProviderConfig = { enabled: true, auto: ["fetch"], keys: [], integration: { kind: "rest", adapter: "direct_markdown" } };
  await assert.rejects(adapter.call("direct_markdown_fetch", { url: "http://127.0.0.1:8080/secret" }, "", cfg), /private IP/);
  await assert.rejects(adapter.call("direct_markdown_fetch", { url: "http://localhost/admin" }, "", cfg), /private or local host/);
  await assert.rejects(adapter.call("direct_markdown_fetch", { url: "http://[::ffff:7f00:1]/admin" }, "", cfg), /private IP/);

  const failingDnsAdapter = new DirectMarkdownAdapter(async () => {
    throw new Error("ENOTFOUND");
  });
  await assert.rejects(
    failingDnsAdapter.call("direct_markdown_fetch", { url: "https://unresolvable.example.test/" }, "", cfg),
    (err: unknown) => err instanceof TargetPageError,
  );

  // Fake-IP TUN (198.18.0.0/15) or split-horizon private DNS must fail closed locally yet allow fetch_auto failover.
  const fakeIpDnsAdapter = new DirectMarkdownAdapter(async () => [{ address: "198.18.0.42" }]);
  await assert.rejects(
    fakeIpDnsAdapter.call("direct_markdown_fetch", { url: "https://vercel.com/docs" }, "", cfg),
    (err: unknown) => err instanceof TargetPageError && err.pageStatus === undefined,
  );

  const original = globalThis.fetch;
  let contentType = "text/markdown; charset=utf-8";
  let body = "# Guide\n\n" + "Detailed markdown documentation content. ".repeat(6);
  globalThis.fetch = async () => new Response(body, {
    status: 200,
    headers: { "Content-Type": contentType, "x-markdown-tokens": "142" },
  });
  try {
    const ok = await adapter.call("direct_markdown_fetch", { url: "https://docs.example.test/guide" }, "", cfg) as { text: string; markdownTokens?: number };
    assert.match(ok.text, /^URL: https:\/\/docs\.example\.test\/guide\n\n# Guide/);
    assert.equal(ok.markdownTokens, 142);

    // Public IPv6 literal should be accepted cleanly without bracket parsing bugs.
    const ipv6Ok = await adapter.call("direct_markdown_fetch", { url: "https://[2606:4700::6810:85e5]/guide" }, "", cfg) as { text: string };
    assert.match(ipv6Ok.text, /# Guide/);

    contentType = "text/html; charset=utf-8";
    body = "<html><body>Hello</body></html>";
    await assert.rejects(
      adapter.call("direct_markdown_fetch", { url: "https://docs.example.test/guide" }, "", cfg),
      (err: unknown) => err instanceof TargetPageError && err.pageStatus === undefined,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("quota reads DeepSeek and Vercel Gateway balances and does not bench TinyFish or Vercel Gateway $0 wallet", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "search-toolkit-quota-"));
  const store = new RotationStore(resolve(dir, "state.db"));
  const original = globalThis.fetch;
  let vgBalance = "4.99";
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("api.deepseek.com/user/balance")) {
      return Response.json({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "12.50" }] });
    }
    if (url.includes("ai-gateway.vercel.sh/v1/credits")) {
      return Response.json({ balance: vgBalance, total_used: "0.01" });
    }
    if (url.includes("agent.tinyfish.ai/v1/wallet")) {
      return Response.json({ available_balance: 0 });
    }
    return new Response("not found", { status: 404 });
  };
  try {
    const dsRows = await readQuota("deepseek", REST("deepseek"), store);
    assert.equal(dsRows[0]?.remaining, 12.5);
    const vgCfg = REST("vercel_gateway");
    const vgRows = await readQuota("vercel_gateway", vgCfg, store);
    assert.equal(vgRows[0]?.remaining, 4.99);
    vgBalance = "0";
    const vgZeroRows = await readQuota("vercel_gateway", vgCfg, store);
    assert.equal(vgZeroRows[0]?.remaining, 0);
    assert.equal(store.status("vercel_gateway", vgCfg.keys).keys[0]?.status.status, "healthy");
    const tfCfg = REST("tinyfish");
    const tfRows = await readQuota("tinyfish", tfCfg, store);
    assert.equal(tfRows[0]?.remaining, 0);
    // TinyFish free tier stays healthy even with $0 paid wallet.
    assert.equal(store.status("tinyfish", tfCfg.keys).keys[0]?.status.status, "healthy");
  } finally {
    globalThis.fetch = original;
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("section extraction ignores fenced code comments and skips empty sibling tab headings; excerpts keep domains intact", () => {
  const doc = [
    "# Docs",
    "## Using DeepSeek Search",
    "```bash",
    "# Not a markdown heading comment",
    "curl https://api.deepseek.com/v1/tools/search",
    "```",
    "This paragraph belongs under Using DeepSeek Search.",
    "",
    "#### Chat Completions",
    "",
    "#### TypeScript",
    "const x = 1;",
    "",
    "### Next Section",
    "Other stuff.",
  ].join("\n");
  const deepseekSec = truncateBody({ content: [{ type: "text", text: doc }] }, 500, { section: "Using DeepSeek Search" }) as { content: Array<{ text: string }> };
  assert.match(deepseekSec.content[0]?.text ?? "", /This paragraph belongs under Using DeepSeek Search/);

  const tabSec = truncateBody({ content: [{ type: "text", text: doc }] }, 500, { section: "Chat Completions" }) as { content: Array<{ text: string }> };
  assert.match(tabSec.content[0]?.text ?? "", /const x = 1;/);
  assert.doesNotMatch(tabSec.content[0]?.text ?? "", /Other stuff/);

  // Domain dots like api-docs.deepseek.com must not split sentences.
  const longText = "Intro sentence about tools. Visit https://api-docs.deepseek.com for v24.13.1 release notes and DeepSeek pricing details. Trailing unrelated text about governance.";
  const focused = focusExcerpt(longText, "DeepSeek pricing", 120);
  assert.match(focused, /api-docs\.deepseek\.com/);

  // Firecrawl { success: false, error } envelope turns into TargetPageError.
  assert.throws(
    () => readableFetchOutput({ content: [{ type: "text", text: JSON.stringify({ success: false, error: { message: "403 blocked", status: 403 } }) }] }),
    (err: unknown) => err instanceof TargetPageError && err.pageStatus === 403,
  );
  assert.equal(isUsableFetchText("Vercel Security Checkpoint - We're verifying your browser to continue. " + "x".repeat(40)), false);
});

test("Serper stays in 1-credit tier for limit<=10 and image language normalizes per provider", () => {
  const candidates = autoCandidates("general", "balanced", { query: "test", limit: 10 });
  assert.equal(candidates.find((c) => c.name === "serper_search")?.nativeArguments?.limit, 10);
  const imgs = imageCandidates({ query: "猫", language: "zh-CN" });
  assert.equal(imgs[0]?.nativeArguments?.searchLang, "zh-hans");
  assert.equal(imgs[1]?.nativeArguments?.hl, "zh-cn");
});

test("upgraded provider adapters send current contracts (Parallel, Octen, TinyFish, Grok, Doubao, Jina, Querit)", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  let reply: unknown = {};
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {},
    });
    return Response.json(reply);
  };
  try {
    // Parallel maps maxCharsPerResult to top-level max_chars_total when maxCharsTotal is omitted.
    reply = { results: [] };
    await new ParallelAdapter().call("parallel_search", { query: "q", maxResults: 4, maxCharsPerResult: 500 }, "k", REST("parallel"));
    assert.equal(calls.at(-1)?.body.max_chars_total, 2000);
    assert.equal((calls.at(-1)?.body.advanced_settings as Record<string, unknown>)?.excerpt_settings, undefined);

    // Octen 5-digit error code extracts leading HTTP status (42901 -> 429) and premier switches endpoint.
    reply = { code: 42901, msg: "rate limit" };
    await assert.rejects(
      new OctenAdapter().call("octen_search", { query: "q", premier: true }, "k", REST("octen")),
      (err: unknown) => err instanceof HttpError && err.status === 429,
    );
    assert.equal(calls.at(-1)?.url, "https://api.octen.ai/search-premier");

    // Grok strips @ on x handles, defaults reasoning low on grok-4.7, and omits reasoning on non-reasoning models.
    reply = { output: [{ type: "message", content: [{ type: "output_text", text: "ok", annotations: [{ url: "https://x.com/a/1" }] }] }] };
    const grokOut = await new GrokAdapter().call(
      "grok_x_search",
      { query: "q", allowedXHandles: ["@elonmusk"] },
      "k",
      REST("grok", { model: "grok-4.7" }),
    ) as { text: string };
    assert.deepEqual(calls.at(-1)?.body.reasoning, { effort: "low" });
    assert.deepEqual(((calls.at(-1)?.body.tools as Array<Record<string, unknown>>)[0])?.allowed_x_handles, ["elonmusk"]);
    assert.doesNotMatch(grokOut.text, /no X search was run/, "suppresses warning when usage details absent but citations present");
    assert.match(grokOut.text, /1 cited source/);

    await new GrokAdapter().call("grok_web_search", { query: "q" }, "k", REST("grok", { model: "grok-4.20-0309-non-reasoning", reasoningEffort: "low" }));
    assert.equal(calls.at(-1)?.body.reasoning, undefined);

    // Doubao sends NeedSummary, surfaces 10406 as 402, does not classify Count exceeds limit as 429, and converts Unix PublishTime.
    reply = { ResponseMetadata: { Error: { CodeN: 10406, Code: "InsufficientBalance", Message: "no credit" } } };
    await assert.rejects(
      new DoubaoAdapter().call("doubao_search", { query: "测试" }, "k", REST("doubao")),
      (err: unknown) => err instanceof HttpError && err.status === 402,
    );
    assert.equal(calls.at(-1)?.body.NeedSummary, true);

    reply = { ResponseMetadata: { Error: { Code: "InvalidParameter", Message: "Count exceeds limit" } } };
    await assert.rejects(
      new DoubaoAdapter().call("doubao_search", { query: "测试" }, "k", REST("doubao")),
      (err: unknown) => err instanceof HttpError && err.status === 502,
    );

    reply = { Result: { WebResults: [{ Title: "T", Url: "https://d.example", Summary: "S", Content: "Full Content", PublishTime: 1761004800 }] } };
    const doubaoFull = await new DoubaoAdapter().call("doubao_search", { query: "测试", needContent: true }, "k", REST("doubao")) as { items: Array<{ text: string; date?: string }> };
    assert.equal(doubaoFull.items[0]?.text, "Full Content");
    assert.equal(doubaoFull.items[0]?.date, "2025-10-21");

    // Brave encodes non-ASCII location headers cleanly without ByteString TypeError.
    reply = { grounding: { generic: [] }, sources: {} };
    await new BraveAdapter().call("brave_llm_context", { query: "coffee", locationCity: "北京" }, "k", REST("brave"));
    assert.equal(calls.at(-1)?.headers.get("x-loc-city"), encodeURIComponent("北京"));

    // Jina sends X-Respond-With: no-content by default.
    reply = { data: [] };
    await new JinaAdapter().call("jina_search", { query: "q" }, "k", REST("jina"));
    assert.equal(calls.at(-1)?.headers.get("x-respond-with"), "no-content");

    // Querit supports error_code=0, chunks flattening on needContent, and querit_contents.
    reply = { error_code: 0, results: { result: [{ title: "Q", url: "https://q.example", chunks: [{ text: "Chunk A" }, { text: "Chunk B" }] }] } };
    const qs = await new QueritAdapter().call("querit_search", { query: "q", needContent: true }, "k", REST("querit")) as { items: Array<{ text: string }> };
    assert.equal(qs.items[0]?.text, "Chunk A\n\nChunk B");

    reply = { error_code: 0, results: { result: [{ title: "Q", url: "https://q.example", content: "Querit body" }] } };
    const qc = await new QueritAdapter().call("querit_contents", { url: "https://q.example" }, "k", REST("querit")) as { text: string };
    assert.equal(calls.at(-1)?.url, "https://api.querit.ai/v1/contents");
    assert.match(qc.text, /Querit body/);

    // Code mode respects excludeDomains: ["github.com"].
    const codeNoGh = autoCandidates("code", "balanced", { query: "rust async", excludeDomains: ["github.com"] });
    const exaCode = codeNoGh.find((c) => c.name === "exa_web_search_advanced_exa");
    assert.equal(exaCode?.nativeArguments?.includeDomains, undefined);
    assert.deepEqual(exaCode?.nativeArguments?.excludeDomains, ["github.com"]);

    // TinyFish renders links when requested.
    reply = { results: [{ url: "https://tf.example", title: "TF", text: "Page", links: [{ text: "Docs", url: "https://tf.example/docs" }] }], errors: [] };
    const tf = await new TinyfishAdapter().call("tinyfish_fetch", { url: "https://tf.example", links: true }, "k", REST("tinyfish")) as { text: string };
    assert.match(tf.text, /Links:\n- Docs: https:\/\/tf\.example\/docs/);
  } finally {
    globalThis.fetch = original;
  }
});

test("HTTP token policy enforces tool allowlist and allowedArgumentValues inside provider_call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "search-toolkit-http-gw-"));
  const configPath = join(dir, "providers.json");
  writeFileSync(configPath, JSON.stringify({
    version: 2,
    statePath: join(dir, "state.db"),
    profile: "lean",
    providers: {
      brave: { enabled: true, auto: ["search"], keys: ["k1"], integration: { kind: "rest", adapter: "brave" } },
      grok: { enabled: true, auto: [], keys: ["k2"], integration: { kind: "rest", adapter: "grok" } },
    },
  }));
  const token = "scoped-gateway-token";
  const toolkit = new SearchToolkit(configPath, { profile: "lean" });
  await toolkit.initialize();
  const runtime = createSearchToolkitHttpApp(toolkit, {
    tokens: [{
      hash: createHash("sha256").update(token).digest("hex"),
      tools: ["provider_tools", "provider_call", "grok_web_search"],
      allowedArgumentValues: { depth: ["fast"] },
    }],
  });
  const listener = runtime.app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => listener.once("listening", r));
  const url = new URL(`http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`);
  const client = new Client({ name: "gw-acl-test", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }) as unknown as Parameters<typeof client.connect>[0]);
    const listed = await client.callTool({ name: "provider_tools", arguments: {} });
    const listText = String((listed.content as Array<{ text?: string }>)[0]?.text ?? "");
    assert.match(listText, /grok_web_search/);
    assert.doesNotMatch(listText, /brave_web_search/);

    const blockedTool = await client.callTool({ name: "provider_call", arguments: { name: "brave_web_search", arguments: { query: "q" } } });
    assert.equal(blockedTool.isError, true);
    assert.match(String((blockedTool.content as Array<{ text?: string }>)[0]?.text), /not available for this token/);

    const blockedArg = await client.callTool({ name: "provider_call", arguments: { name: "grok_web_search", arguments: { query: "q", depth: "max" } } });
    assert.equal(blockedArg.isError, true);
    assert.match(String((blockedArg.content as Array<{ text?: string }>)[0]?.text), /depth=max is not allowed/);
  } finally {
    await client.close();
    await new Promise<void>((r) => listener.close(() => r()));
    await runtime.close();
    await toolkit.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("direct_markdown skipped probe does not consume fetch_auto failover slots and validates timeoutMs", async () => {
  assert.throws(
    () => normalizeConfig({
      version: 2,
      statePath: "state.db",
      providers: {
        direct_markdown: {
          enabled: true,
          auto: ["fetch"],
          keys: [],
          integration: { kind: "rest", adapter: "direct_markdown" },
          options: { timeoutMs: 25_000 },
        },
      },
    }),
    /options\.timeoutMs must be an integer from 1000 to 15000/,
  );

  const dir = mkdtempSync(join(tmpdir(), "search-toolkit-dm-skip-"));
  const configPath = join(dir, "providers.json");
  writeFileSync(configPath, JSON.stringify({
    version: 2,
    statePath: join(dir, "state.db"),
    providers: {
      direct_markdown: { enabled: true, auto: ["fetch"], keys: [], integration: { kind: "rest", adapter: "direct_markdown" } },
      deepseek: { enabled: true, auto: ["fetch"], keys: ["sk-ds"], integration: { kind: "rest", adapter: "deepseek" } },
      parallel: { enabled: true, auto: ["fetch"], keys: ["sk-par"], integration: { kind: "rest", adapter: "parallel" } },
      you: { enabled: true, auto: ["fetch"], keys: ["sk-you"], integration: { kind: "rest", adapter: "you" } },
    },
  }));
  const toolkit = new SearchToolkit(configPath, { cache: false });
  await toolkit.initialize();
  const original = globalThis.fetch;
  const hitHosts: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    hitHosts.push(new URL(url).hostname);
    if (url.includes("api.deepseek.com")) {
      return new Response('{"error":"blocked"}', { status: 403 });
    }
    if (url.includes("api.parallel.ai")) {
      return Response.json({ results: [], errors: [{ url: "https://1.1.1.1/page", http_status_code: 403, content: "blocked" }] });
    }
    if (url.includes("ydc-index.io")) {
      return Response.json({
        title: "Success Page",
        url: "https://1.1.1.1/page",
        contents: { markdown: "# Success\n\n" + "Readable body content from You.com fallback. ".repeat(5) },
      });
    }
    // direct_markdown hits https://1.1.1.1/page directly and receives HTML -> skipped cleanly.
    return new Response("<html><body>HTML only</body></html>", { status: 200, headers: { "Content-Type": "text/html" } });
  };
  try {
    // 1.1.1.1 skips DNS so test stays 100% offline. direct_markdown (skipped) + deepseek (fail #1)
    // + parallel (fail #2) + you (success #3): requires skipped probe NOT to consume the 3-provider cap!
    const out = await toolkit.callTool("fetch_auto", { url: "https://1.1.1.1/page" }) as {
      content: Array<{ text?: string }>;
      isError?: boolean;
    };
    assert.equal(out.isError, undefined);
    const text = out.content.map((block) => block.text ?? "").join("\n");
    assert.match(text, /Readable body content from You\.com fallback/);
    assert.doesNotMatch(text, /direct_markdown_fetch:skipped/);
    assert.deepEqual(hitHosts, ["1.1.1.1", "api.deepseek.com", "api.parallel.ai", "ydc-index.io"]);
  } finally {
    globalThis.fetch = original;
    await toolkit.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetch_auto auto-fills schema-required objective for Firecrawl hosted v2 MCP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "search-toolkit-fc-obj-"));
  const configPath = join(dir, "providers.json");
  writeFileSync(configPath, JSON.stringify({
    version: 2,
    statePath: join(dir, "state.db"),
    providers: {
      firecrawl: {
        enabled: true,
        auto: ["fetch"],
        keys: ["fc-test"],
        integration: { kind: "remote_mcp", url: "https://mcp.firecrawl.dev/v2/mcp", auth: { kind: "bearer" } },
        toolPolicy: { allow: ["firecrawl_scrape"] },
      },
    },
  }));
  const toolkit = new SearchToolkit(configPath, { cache: false });
  let capturedArgs: Record<string, unknown> = {};
  const bindings = (toolkit as unknown as { bindings: Map<string, unknown> }).bindings;
  bindings.set("firecrawl_firecrawl_scrape", {
    provider: "firecrawl",
    upstreamName: "firecrawl_scrape",
    exposed: {
      name: "firecrawl_firecrawl_scrape",
      description: "Scrape one URL",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          formats: { type: "array", items: { type: "string" } },
          onlyMainContent: { type: "boolean" },
          objective: { type: "string", minLength: 1 },
        },
        required: ["url", "objective"],
        additionalProperties: false,
      },
    },
    call: async (args: Record<string, unknown>) => {
      capturedArgs = args;
      return { content: [{ type: "text", text: "# Example\n\n" + "Readable scraped body content from Firecrawl hosted v2. ".repeat(4) }] };
    },
  });
  for (const managed of (toolkit as unknown as { managementBindings: () => Array<{ exposed: { name: string } }> }).managementBindings()) {
    bindings.set(managed.exposed.name, managed);
  }
  try {
    const out = await toolkit.callTool("fetch_auto", { url: "https://example.com", quality: "max" }) as { isError?: boolean };
    assert.equal(out.isError, undefined);
    assert.equal(capturedArgs.url, "https://example.com/");
    assert.equal(typeof capturedArgs.objective, "string");
    assert.ok(String(capturedArgs.objective).length > 5);
  } finally {
    await toolkit.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
