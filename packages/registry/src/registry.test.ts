import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { createRegistryServer } from "./index.js";

let port = 0;
let close: () => Promise<void>;
let dataDir: string;

function req(
  method: string,
  urlPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown; raw: Buffer; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const r = http.request(
      { method, port, host: "127.0.0.1", path: urlPath, headers: { "content-type": "application/json", ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          let json: unknown = null;
          try {
            json = JSON.parse(raw.toString("utf8"));
          } catch {
            /* binary body */
          }
          resolve({ status: res.statusCode ?? 0, json, raw, headers: res.headers });
        });
      },
    );
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

async function makeTarball(manifest: Record<string, unknown>, files: Record<string, string>): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpack-fixture-"));
  for (const [rel, content] of Object.entries({ "agentpack.json": JSON.stringify(manifest), ...files })) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  const tgz = path.join(dir, "out.tgz");
  await tar.c({ file: tgz, cwd: dir, gzip: true }, Object.keys({ "agentpack.json": "", ...files }));
  return fs.readFileSync(tgz);
}

const MANIFEST = {
  name: "test-agent",
  version: "0.1.0",
  description: "A test agent",
  entrypoint: "index.js",
  runtime: "node20",
  scopes: ["llm:call"],
  models: { preferred: [] },
};

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpack-registry-"));
  const r = await createRegistryServer({ port: 0, dataDir });
  port = r.port;
  close = r.close;
});

after(async () => {
  await close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("creates a publisher and rejects bad names", async () => {
  const res = await req("POST", "/publishers", { name: "alice" });
  assert.equal(res.status, 201);
  const j = res.json as { token: string };
  assert.ok(j.token.startsWith("ap_"));

  const bad = await req("POST", "/publishers", { name: "Bad Name!" });
  assert.equal(bad.status, 400);
});

test("publishes, lists, searches, downloads", async () => {
  const pub = await req("POST", "/publishers", { name: "bob" });
  const token = (pub.json as { token: string }).token;

  const tgz = await makeTarball(MANIFEST, { "index.js": "console.log('hi')" });
  const pubRes = await req("POST", "/packages", { manifest: MANIFEST, tarball: tgz.toString("base64") }, { authorization: `Bearer ${token}` });
  assert.equal(pubRes.status, 201, JSON.stringify(pubRes.json));
  const sha = (pubRes.json as { sha256: string }).sha256;

  // anonymous reads
  const list = await req("GET", "/packages");
  const names = (list.json as { packages: { name: string }[] }).packages.map((p) => p.name);
  assert.ok(names.includes("test-agent"));

  const meta = await req("GET", "/packages/test-agent");
  assert.equal(meta.status, 200);
  const mj = meta.json as { latest: string; versions: { version: string; sha256: string }[] };
  assert.equal(mj.latest, "0.1.0");
  assert.equal(mj.versions[0].sha256, sha);

  const vers = await req("GET", "/packages/test-agent/versions");
  assert.deepEqual((vers.json as { versions: string[] }).versions, ["0.1.0"]);

  const search = await req("GET", "/search?q=test");
  assert.equal((search.json as { packages: unknown[] }).packages.length, 1);
  const none = await req("GET", "/search?q=zzzz");
  assert.equal((none.json as { packages: unknown[] }).packages.length, 0);

  const dl = await req("GET", "/packages/test-agent/0.1.0.tgz");
  assert.equal(dl.status, 200);
  assert.equal(dl.headers["x-agentpack-sha256"], sha);
  assert.equal(dl.raw.length, tgz.length);
});

test("requires auth to publish; enforces ownership and duplicate versions", async () => {
  const noAuth = await req("POST", "/packages", { manifest: MANIFEST, tarball: "AA==" });
  assert.equal(noAuth.status, 401);

  const mallory = await req("POST", "/publishers", { name: "mallory" });
  const badToken = (mallory.json as { token: string }).token;
  const tgz = await makeTarball(MANIFEST, { "index.js": "x" });
  const steal = await req("POST", "/packages", { manifest: MANIFEST, tarball: tgz.toString("base64") }, { authorization: `Bearer ${badToken}` });
  assert.equal(steal.status, 403);

  const bob = await req("POST", "/publishers", { name: "bob2" });
  const bobTok = (bob.json as { token: string }).token;
  const mine = { ...MANIFEST, name: "bob2-agent" };
  const tgz2 = await makeTarball(mine, {});
  assert.equal((await req("POST", "/packages", { manifest: mine, tarball: tgz2.toString("base64") }, { authorization: `Bearer ${bobTok}` })).status, 201);
  assert.equal((await req("POST", "/packages", { manifest: mine, tarball: tgz2.toString("base64") }, { authorization: `Bearer ${bobTok}` })).status, 409);
});

test("rejects manifest/tarball mismatch", async () => {
  const pub = await req("POST", "/publishers", { name: "carol" });
  const token = (pub.json as { token: string }).token;
  const embedded = { ...MANIFEST, name: "other-name" };
  const tgz = await makeTarball(embedded, {});
  const res = await req("POST", "/packages", { manifest: { ...MANIFEST, name: "claimed-name" }, tarball: tgz.toString("base64") }, { authorization: `Bearer ${token}` });
  assert.equal(res.status, 422);
});
