import assert from "node:assert/strict";
import test from "node:test";
import { HttpError, shouldFailoverProvider, shouldRetryWithNextKey, statusFromError } from "../src/errors.js";

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
