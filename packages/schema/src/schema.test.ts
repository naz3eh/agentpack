import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseScope,
  isValidScope,
  parseManifest,
  manifestIssues,
  policyFromManifest,
  domainAllowed,
} from "./index.js";

test("parses each valid scope form", () => {
  assert.equal(parseScope("net:example.com").kind, "net");
  assert.equal(parseScope("net:*").value, "*");
  assert.equal(parseScope("fs:read:/downloads").kind, "fs:read");
  assert.equal(parseScope("fs:write:/tmp/x").kind, "fs:write");
  assert.equal(parseScope("env:MY_KEY").value, "MY_KEY");
  assert.equal(parseScope("llm:call").kind, "llm:call");
  assert.equal(parseScope("shell:exec").dangerous, true);
});

test("rejects scopes outside the vocabulary", () => {
  for (const bad of [
    "net",
    "net:",
    "fs:/tmp",
    "fs:read:relative/path",
    "env:lower-case!",
    "env:",
    "exec:shell",
    "root:all",
    "",
    "net:bad domain",
    "net:exa mple.com",
  ]) {
    assert.equal(isValidScope(bad), false, bad);
  }
});

test("accepts subdomains, IPs, hyphenated names", () => {
  assert.ok(isValidScope("net:api.example.co.uk"));
  assert.ok(isValidScope("net:127.0.0.1"));
  assert.ok(isValidScope("env:MY_VAR_2"));
});

test("manifest validation", () => {
  const good = {
    name: "summarize-url",
    version: "0.1.0",
    description: "Summarizes a web page",
    entrypoint: "dist/index.js",
    runtime: "node20",
    scopes: ["net:example.com", "llm:call"],
    models: { preferred: ["gpt-4o-mini"] },
  };
  const m = parseManifest(good);
  assert.equal(m.name, "summarize-url");
  assert.deepEqual(m.models.preferred, ["gpt-4o-mini"]);
});

test("manifest rejects bad names, versions, unknown fields, bad scopes", () => {
  const base = {
    name: "x",
    version: "0.1.0",
    description: "d",
    entrypoint: "i.js",
    runtime: "node20",
    scopes: [],
  };
  assert.ok(manifestIssues({ ...base, name: "UPPER" }).length > 0);
  assert.ok(manifestIssues({ ...base, version: "1.0" }).length > 0);
  assert.ok(manifestIssues({ ...base, runtime: "node18" }).length > 0);
  assert.ok(manifestIssues({ ...base, extra: 1 }).length > 0);
  assert.ok(manifestIssues({ ...base, scopes: ["anything:goes"] }).length > 0);
  assert.ok(manifestIssues({ ...base, entrypoint: "../escape.js" }).length > 0);
});

test("policyFromManifest compiles the runtime policy", () => {
  const m = parseManifest({
    name: "x",
    version: "1.0.0",
    description: "d",
    entrypoint: "i.js",
    runtime: "node20",
    scopes: [
      "net:example.com",
      "fs:read:/dl",
      "fs:write:/out",
      "env:A",
      "llm:call",
      "shell:exec",
    ],
    models: { preferred: ["m1"] },
  });
  const p = policyFromManifest(m);
  assert.deepEqual(p.netDomains, ["example.com"]);
  assert.deepEqual(p.fsRead, ["/dl"]);
  assert.deepEqual(p.fsWrite, ["/out"]);
  assert.deepEqual(p.env, ["A"]);
  assert.equal(p.llmCall, true);
  assert.equal(p.shellExec, true);
  assert.deepEqual(p.modelsPreferred, ["m1"]);
});

test("net:* produces a null allowlist (all domains)", () => {
  const m = parseManifest({
    name: "x",
    version: "1.0.0",
    description: "d",
    entrypoint: "i.js",
    runtime: "node20",
    scopes: ["net:*"],
  });
  assert.equal(policyFromManifest(m).netDomains, null);
});

test("domainAllowed matches exact and subdomains only", () => {
  assert.ok(domainAllowed("example.com", ["example.com"]));
  assert.ok(domainAllowed("api.example.com", ["example.com"]));
  assert.ok(!domainAllowed("notexample.com", ["example.com"]));
  assert.ok(!domainAllowed("example.com.evil.io", ["example.com"]));
  assert.ok(domainAllowed("anything.io", null));
  assert.ok(domainAllowed("EXAMPLE.COM", ["example.com"]));
});
