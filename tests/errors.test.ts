import assert from "node:assert/strict";
import test from "node:test";
import { shouldRetryWithNextKey, statusFromError } from "../src/errors.js";

test("request-shape errors do not rotate through good keys", () => {
  const status = statusFromError(new Error("validation error: Unexpected keyword argument limit"));
  assert.equal(status, 422);
  assert.equal(shouldRetryWithNextKey(status), false);
});

test("rate limits and server errors may retry another key", () => {
  assert.equal(shouldRetryWithNextKey(429), true);
  assert.equal(shouldRetryWithNextKey(503), true);
});
