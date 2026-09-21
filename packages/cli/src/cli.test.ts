import { test } from "node:test";
import assert from "node:assert/strict";
import { parseManifest } from "@agentpack/schema";
import { parseNameVersion } from "./install.js";
import { fallbackReview } from "./review.js";
import { fallbackFind } from "./find.js";
import { suggestScopes } from "./initcmd.js";

function m(over: Partial<Parameters<typeof parseManifest>[0]> & { scopes: string[]; description: string }) {
  return parseManifest({ name: "x", version: "1.0.0", entrypoint: "i.js", runtime: "node20", ...over });
}

test("parseNameVersion", () => {
  assert.deepEqual(parseNameVersion("foo"), { name: "foo" });
  assert.deepEqual(parseNameVersion("foo@1.2.3"), { name: "foo", version: "1.2.3" });
});

test("fallbackReview flags fs:write for a text-only description", () => {
  const r = fallbackReview(m({ description: "Summarizes text", scopes: ["llm:call", "fs:write:/"] }));
  assert.equal(r.verdict, "over_permissioned");
});

test("fallbackReview flags shell:exec + net as suspicious", () => {
  const r = fallbackReview(m({ description: "Syncs files", scopes: ["shell:exec", "net:*", "fs:read:/dl"] }));
  assert.equal(r.verdict, "suspicious");
});

test("fallbackReview passes a matching manifest", () => {
  const r = fallbackReview(
    m({ description: "Fetches a web page and summarizes it", scopes: ["net:*", "llm:call", "env:PAGE_URL"] }),
  );
  assert.equal(r.verdict, "reasonable");
});

test("fallbackFind scores by keyword overlap, returns null when none", () => {
  const catalog = [
    { name: "summarize-url", description: "Summarizes a web page" },
    { name: "watch-downloads", description: "Watches the downloads folder" },
  ];
  assert.equal(fallbackFind("summarize a web page for me", catalog), "summarize-url");
  assert.equal(fallbackFind("watch my downloads", catalog), "watch-downloads");
  assert.equal(fallbackFind("quantum blockchain entanglement", catalog), null);
});

test("suggestScopes falls back to keyword matching", async () => {
  const r = await suggestScopes("watches my downloads folder and files receipts with an llm", null);
  assert.equal(r.source, "fallback");
  assert.ok(r.scopes.includes("llm:call"));
  assert.ok(r.scopes.some((s) => s.startsWith("fs:read:")));
});
