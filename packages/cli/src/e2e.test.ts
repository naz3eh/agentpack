import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRegistryServer } from "@agentpack/registry";

const BIN = path.join(__dirname, "bin.js");
const EXAMPLE = path.resolve(__dirname, "../../../examples/summarize-url");

let apHome: string;
let dataDir: string;
let registryUrl: string;
let pageUrl: string;
let upstreamUrl: string;
let sawAuth: string | null = null;
const closers: (() => Promise<void>)[] = [];

function serve(handler: http.RequestListener): Promise<number> {
  return new Promise((r) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => {
      closers.push(() => new Promise<void>((d) => s.close(() => d())));
      r((s.address() as { port: number }).port);
    });
  });
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// async spawn — spawnSync would deadlock: the in-process registry can't answer
// a spawned CLI while the test's event loop is blocked.
function cli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: {
        ...process.env,
        AGENTPACK_HOME: apHome,
        AGENTPACK_REGISTRY: registryUrl,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`cli timed out: ${args.join(" ")}\n${stdout}\n${stderr}`));
    }, 60_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function writeAgent(dir: string, manifest: object, code: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "agentpack.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, "index.js"), code);
}

before(async () => {
  apHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentpack-home-"));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpack-reg-"));

  const reg = await createRegistryServer({ port: 0, dataDir });
  registryUrl = `http://127.0.0.1:${reg.port}`;
  closers.push(reg.close);

  const pagePort = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body><h1>Hello Agentpack</h1><p>test page content</p></body></html>");
  });
  pageUrl = `http://127.0.0.1:${pagePort}/`;

  const upPort = await serve((req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {

      sawAuth = req.headers.authorization ?? null;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: "TEST_SUMMARY_OK" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      });
    } else {
      res.writeHead(404).end();
    }
  });
  upstreamUrl = `http://127.0.0.1:${upPort}/v1`;
});

after(async () => {
  for (const c of closers) await c();
  fs.rmSync(apHome, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("e2e: publish -> install -> run summarize-url against fake LLM broker", async () => {
  const pub = await cli(["publisher", "create", "alice"]);
  assert.equal(pub.status, 0, pub.stderr);
  assert.match(pub.stdout, /ap_/);

  const published = await cli(["publish", EXAMPLE, "--publisher", "alice"]);
  assert.equal(published.status, 0, published.stderr);
  assert.match(published.stdout, /published summarize-url@0\.1\.0/);

  const installed = await cli(["install", "summarize-url", "-y"]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /installed summarize-url@0\.1\.0/);

  const run = await cli(["run", "summarize-url"], {
    PAGE_URL: pageUrl,
    AGENTPACK_LLM_UPSTREAM: upstreamUrl,
    AGENTPACK_LLM_API_KEY: "sk-user-secret",
    UNDECLARED_SECRET: "should-not-leak",
  });
  assert.equal(run.status, 0, `stdout=${run.stdout}\nstderr=${run.stderr}`);
  assert.match(run.stdout, /SUMMARY: TEST_SUMMARY_OK/);
  // the broker injected the USER's key upstream — the agent env never carried it
  assert.equal(sawAuth, "Bearer sk-user-secret");
});

const PROBE_CODE = `
const fs = require("fs");
const out = {};
const done = (k, v) => (out[k] = String(v));
const trySync = (fn) => { try { return fn(); } catch (e) { return "ERR:" + (e.code || e.message); } };

(async () => {
  done("env_declared", process.env.PAGE_URL);
  done("env_undeclared", process.env.UNDECLARED_SECRET);
  done("env_llm_key", process.env.AGENTPACK_LLM_API_KEY);

  try { const r = await fetch(process.env.PAGE_URL); done("fetch_allowed", r.status); }
  catch (e) { done("fetch_allowed", "ERR:" + e.message); }
  try { const r = await fetch("http://example.com/"); done("fetch_denied", r.status); }
  catch (e) { done("fetch_denied", "ERR:" + (e.code || e.message)); }

  done("fs_write_allowed", trySync(() => { fs.writeFileSync(ALLOWED_DIR + "/x.txt", "hi"); return "ok"; }));
  done("fs_write_denied", trySync(() => { fs.writeFileSync("/tmp/agentpack-evil.txt", "x"); return "ALLOWED"; }));
  done("fs_read_denied", trySync(() => { fs.readFileSync("/etc/hostname", "utf8"); return "ALLOWED"; }));
  done("shell_denied", trySync(() => { require("child_process").execSync("true"); return "ALLOWED"; }));

  const call = (model) => fetch(process.env.AGENTPACK_LLM_URL + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
  try { done("llm_ok", (await call("gpt-4o-mini")).status); } catch (e) { done("llm_ok", "ERR:" + e.message); }
  try { done("llm_denied", (await call("evil-model")).status); } catch (e) { done("llm_denied", "ERR:" + e.message); }
  try { done("llm_cap", (await call("gpt-4o-mini")).status); } catch (e) { done("llm_cap", "ERR:" + e.message); }

  console.log("PROBE_JSON:" + JSON.stringify(out));
})().catch((e) => { console.log("PROBE_FATAL:" + (e.code || e.message)); process.exit(1); });
`;

test("e2e: probe agent — scope denials + broker caps enforced", async () => {
  const allowedDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpack-allowed-"));
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpack-probe-src-"));
  writeAgent(
    probeDir,
    {
      name: "probe-agent",
      version: "0.0.1",
      description: "E2E probe agent for scope enforcement",
      entrypoint: "index.js",
      runtime: "node20",
      scopes: ["net:127.0.0.1", "env:PAGE_URL", "llm:call", `fs:write:${allowedDir}`],
      models: { preferred: ["gpt-4o-mini"] },
    },
    PROBE_CODE.replace("ALLOWED_DIR", JSON.stringify(allowedDir)),
  );

  assert.equal((await cli(["publish", probeDir, "--publisher", "alice"])).status, 0);
  assert.equal((await cli(["install", "probe-agent", "-y"])).status, 0);

  const run = await cli(["run", "probe-agent"], {
    PAGE_URL: pageUrl,
    AGENTPACK_LLM_UPSTREAM: upstreamUrl,
    AGENTPACK_LLM_API_KEY: "sk-user-secret",
    AGENTPACK_LLM_MAX_CALLS: "2",
    UNDECLARED_SECRET: "should-not-leak",
  });
  assert.equal(run.status, 0, `stdout=${run.stdout}\nstderr=${run.stderr}`);
  const line = run.stdout.split("\n").find((l) => l.startsWith("PROBE_JSON:"));
  assert.ok(line, `no probe output.\nstdout=${run.stdout}\nstderr=${run.stderr}`);
  const probe = JSON.parse(line.slice("PROBE_JSON:".length)) as Record<string, string>;

  // allowed path works
  assert.equal(probe.env_declared, pageUrl);
  assert.equal(probe.fetch_allowed, "200");
  assert.equal(probe.llm_ok, "200");
  assert.equal(probe.fs_write_allowed, "ok");

  // denials
  assert.match(probe.env_undeclared, /undefined/);
  assert.match(probe.env_llm_key, /undefined/);
  assert.match(probe.fetch_denied, /ERR:.*(blocked|EPERM)/i);
  assert.match(probe.fs_write_denied, /ERR:EPERM/);
  assert.match(probe.fs_read_denied, /ERR:EPERM/);
  assert.match(probe.shell_denied, /ERR:EPERM/);
  assert.equal(probe.llm_denied, "403"); // model not in models.preferred
  assert.equal(probe.llm_cap, "429"); // call cap = 2
});
