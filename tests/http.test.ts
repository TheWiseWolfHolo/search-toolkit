import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { boundedInteger, createSearchToolkitHttpApp, parseHttpTokenPolicies } from "../src/http.js";
import { SearchToolkit } from "../src/toolkit.js";

test("Streamable HTTP serves the shared toolkit behind bearer authentication", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-http-"));
  const configPath = join(directory, "providers.json");
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    statePath: join(directory, "state.db"),
    providers: {
      brave: {
        enabled: true,
        automatic: true,
        keys: ["test-key"],
        integration: { kind: "rest", adapter: "brave" },
      },
    },
  }));
  const ownerToken = "owner-test-token";
  const guestToken = "guest-test-token";
  const limitedToken = "limited-test-token";
  const toolkit = new SearchToolkit(configPath);
  await toolkit.initialize();
  const runtime = createSearchToolkitHttpApp(toolkit, {
    tokens: [
      { hash: createHash("sha256").update(ownerToken).digest("hex") },
      {
        hash: createHash("sha256").update(guestToken).digest("hex"),
        tools: ["search_auto", "search_images"],
        requestsPerMinute: 30,
        maxSessions: 1,
      },
      {
        hash: createHash("sha256").update(limitedToken).digest("hex"),
        tools: ["search_pool_status"],
        requestsPerMinute: 1,
      },
    ],
  });
  const listener = runtime.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  const port = (listener.address() as AddressInfo).port;
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  try {
    const unauthorized = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(unauthorized.status, 401);

    const owner = new Client({ name: "search-toolkit-http-owner-test", version: "1.0.0" });
    const ownerTransport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${ownerToken}` } },
    });
    await owner.connect(ownerTransport as unknown as Parameters<typeof owner.connect>[0]);
    const ownerTools = await owner.listTools();
    assert.ok(ownerTools.tools.some((tool) => tool.name === "search_pool_status"));
    assert.ok(ownerTransport.sessionId);

    const ownerSecond = new Client({ name: "search-toolkit-http-owner-second-test", version: "1.0.0" });
    const ownerSecondTransport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${ownerToken}` } },
    });
    await ownerSecond.connect(ownerSecondTransport as unknown as Parameters<typeof ownerSecond.connect>[0]);
    assert.ok((await ownerSecond.listTools()).tools.length > 0);

    const crossTokenSession = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${guestToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Session-Id": ownerTransport.sessionId ?? "",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    assert.equal(crossTokenSession.status, 403);

    const guest = new Client({ name: "search-toolkit-http-guest-test", version: "1.0.0" });
    const guestTransport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${guestToken}` } },
    });
    await guest.connect(guestTransport as unknown as Parameters<typeof guest.connect>[0]);
    const guestTools = await guest.listTools();
    assert.deepEqual(guestTools.tools.map((tool) => tool.name), ["search_auto", "search_images"]);
    const excessSession = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${guestToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "excess-session-test", version: "1.0.0" },
        },
      }),
    });
    assert.equal(excessSession.status, 429);
    const denied = await guest.callTool({ name: "search_pool_status", arguments: {} });
    assert.equal(denied.isError, true);
    const invalidArguments = [
      {},
      { query: "" },
      { query: "image", limit: "abc" },
      { query: "image", limit: 21 },
      { query: "image", bogusField: true },
    ];
    for (const arguments_ of invalidArguments) {
      const invalid = await guest.callTool({ name: "search_images", arguments: arguments_ });
      assert.equal(invalid.isError, true);
      const invalidContent = invalid.content as Array<{ type: string; text?: string }>;
      assert.match(String(invalidContent[0]?.text ?? ""), /Invalid arguments for search_images/);
    }

    const limited = new Client({ name: "search-toolkit-http-limit-test", version: "1.0.0" });
    const limitedTransport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${limitedToken}` } },
    });
    await limited.connect(limitedTransport as unknown as Parameters<typeof limited.connect>[0]);
    assert.equal((await limited.callTool({ name: "search_pool_status", arguments: {} })).isError, undefined);
    const rateLimited = await limited.callTool({ name: "search_pool_status", arguments: {} });
    assert.equal(rateLimited.isError, true);
    const rateContent = rateLimited.content as Array<{ type: string; text?: string }>;
    assert.match(String(rateContent[0]?.text ?? ""), /Rate limit exceeded/);

    await Promise.all([owner.close(), ownerSecond.close(), guest.close(), limited.close()]);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await runtime.close();
    await toolkit.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("HTTP numeric settings and token policies use safe boundaries", () => {
  assert.equal(boundedInteger(Number.NaN, 18_473, 1, 65_535), 18_473);
  assert.equal(boundedInteger(-1, 1_800_000, 1_000, 86_400_000), 1_800_000);
  assert.deepEqual(parseHttpTokenPolicies('[{"hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","tools":["search_auto"],"requestsPerMinute":30,"maxSessions":8}]'), [{
    hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    tools: ["search_auto"],
    requestsPerMinute: 30,
    maxSessions: 8,
  }]);
});
