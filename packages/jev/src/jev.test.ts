import { test } from "node:test";
import assert from "node:assert/strict";
import { jevOr, getJevClient, type JevClient } from "./index.js";

const fakeClient: JevClient = {
  async choose() {
    return { choice: "picked", confidence: 0.9 };
  },
};

const brokenClient: JevClient = {
  async choose() {
    throw new Error("api down");
  },
};

test("jevOr uses the client when present", async () => {
  const r = await jevOr(fakeClient, async (c) => (await c.choose({}, "q", "i", { a: "x" })).choice, () => "fb");
  assert.equal(r.value, "picked");
  assert.equal(r.source, "jev");
});

test("jevOr falls back on client error", async () => {
  const r = await jevOr(brokenClient, async (c) => (await c.choose({}, "q", "i", { a: "x" })).choice, () => "fb");
  assert.equal(r.value, "fb");
  assert.equal(r.source, "fallback");
});

test("jevOr falls back when no client", async () => {
  const r = await jevOr(null, async (c) => (await c.choose({}, "q", "i", { a: "x" })).choice, () => "fb");
  assert.equal(r.value, "fb");
  assert.equal(r.source, "fallback");
});

test("getJevClient returns null without a key", () => {
  assert.equal(getJevClient({}), null);
  assert.equal(getJevClient({ TYPESAFE_API_KEY: "  " }), null);
});
