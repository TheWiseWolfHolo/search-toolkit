import assert from "node:assert/strict";
import test from "node:test";
import {
  HttpError, isConnectionFailure, keyFaultStatusFromToolText, parseRetryAfter,
  shouldFailoverProvider, shouldRetryWithNextKey, statusFromError, ToolResultError,
} from "../src/errors.js";

test("request-shape errors do not rotate through good keys", () => {
  const status = statusFromError(new Error("validation error: Unexpected keyword argument limit"));
  assert.equal(status, 422);
  assert.equal(shouldRetryWithNextKey(status), false);
});

test("rate limits and server errors may retry another key", () => {
  assert.equal(shouldRetryWithNextKey(429), true);
  assert.equal(shouldRetryWithNextKey(503), true);
});

test("explicit HTTP status outranks request-error wording", () => {
  assert.equal(statusFromError(new Error("HTTP 500: invalid parameter in gateway")), 500);
  assert.equal(statusFromError(new Error("validation error: invalid parameter")), 422);
});

test("provider failover recognizes availability failures without hiding code or policy errors", () => {
  for (const error of [
    new HttpError("HTTP 401: unauthorized", 401),
    new HttpError("HTTP 402: balance unavailable", 402),
    new HttpError("HTTP 403: API key permission denied", 403),
    new HttpError("HTTP 503: unavailable", 503),
    new Error("exa upstream tool error: Rate limit exceeded, please retry"),
    new Error("tavily upstream tool error: Service temporarily unavailable"),
    new Error("parallel has no healthy key slots available"),
  ]) assert.equal(shouldFailoverProvider(error), true, error.message);

  for (const error of [
    new HttpError("HTTP 422: invalid request", 422),
    new HttpError("HTTP 403: blocked by safety policy", 403),
    new TypeError("Cannot read properties of undefined"),
    new Error("unexpected adapter response structure"),
  ]) assert.equal(shouldFailoverProvider(error), false, error.message);
});

test("only key-attributable tool text is treated as a key fault", () => {
  assert.equal(keyFaultStatusFromToolText("Invalid API key provided"), 401);
  assert.equal(keyFaultStatusFromToolText("Error: Unauthorized"), 401);
  assert.equal(keyFaultStatusFromToolText("You have exceeded your quota for this month"), 402);
  assert.equal(keyFaultStatusFromToolText("Insufficient credits"), 402);
  assert.equal(keyFaultStatusFromToolText("Rate limit exceeded, please retry"), 429);
  // A scraped page answering 403/404 is the target's verdict, not the key's.
  assert.equal(keyFaultStatusFromToolText("Failed to scrape URL. Status code: 403 Forbidden"), undefined);
  assert.equal(keyFaultStatusFromToolText("Page not found (status 404)"), undefined);
  assert.equal(keyFaultStatusFromToolText("Timed out waiting for selector"), undefined);
});

test("statusFromError reads transport status codes and ignores tool-error text", () => {
  const transport = Object.assign(new Error("Streamable HTTP error: Error POSTing to endpoint"), { code: 401 });
  assert.equal(statusFromError(transport), 401);
  assert.equal(statusFromError(Object.assign(new Error("MCP error -32602: bad params"), { code: -32_602 })), 422);
  assert.equal(statusFromError(Object.assign(new Error("MCP error -32000: Connection closed"), { code: -32_000 })), undefined);
  assert.equal(statusFromError(new ToolResultError("scrape said status 403", [])), undefined);
  assert.equal(statusFromError(new ToolResultError("bad key", [], 401)), 401);
});

test("connection failures are told apart from request or key failures", () => {
  assert.equal(isConnectionFailure(Object.assign(new Error("MCP error -32000: Connection closed"), { code: -32_000 })), true);
  assert.equal(isConnectionFailure(Object.assign(new Error("session gone"), { code: 404 })), true);
  assert.equal(isConnectionFailure(new Error("Not connected")), true);
  assert.equal(isConnectionFailure(new HttpError("HTTP 401: nope", 401)), false);
  assert.equal(isConnectionFailure(new Error("validation error")), false);
});

test("Retry-After accepts seconds and HTTP dates", () => {
  assert.equal(parseRetryAfter("30"), 30_000);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter("soon"), undefined);
  const now = Date.parse("2026-10-02T00:00:00Z");
  assert.equal(parseRetryAfter("Fri, 02 Oct 2026 00:01:00 GMT", now), 60_000);
});
