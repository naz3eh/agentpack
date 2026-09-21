import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseManifest, manifestIssues, type Manifest } from "@agentpack/schema";
import { RegistryDb } from "./db.js";
import { extractManifestFromTarball } from "./tarball.js";

export interface RegistryOptions {
  port?: number;
  host?: string;
  /** Directory for registry.db + blob storage. */
  dataDir: string;
}

const MAX_BODY = 64 * 1024 * 1024;

interface Ctx {
  db: RegistryDb;
  blobsDir: string;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function publicVersion(ctx: Ctx, name: string, v: { version: string; sha256: string; size: number; manifest: string; created_at: string }) {
  const manifest = JSON.parse(v.manifest) as Manifest;
  return {
    version: v.version,
    sha256: v.sha256,
    size: v.size,
    publishedAt: v.created_at,
    manifest,
    dist: {
      tarball: `/packages/${encodeURIComponent(name)}/${encodeURIComponent(v.version)}.tgz`,
      sha256: v.sha256,
    },
  };
}

async function handlePublish(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const publisher = token ? ctx.db.publisherForToken(token) : undefined;
  if (!publisher) throw new HttpError(401, "missing or invalid publisher token");

  const body = JSON.parse((await readBody(req)).toString("utf8")) as {
    manifest?: unknown;
    tarball?: string;
  };
  if (!body.manifest || typeof body.tarball !== "string") {
    throw new HttpError(400, "expected JSON {manifest, tarball} where tarball is base64");
  }
  const issues = manifestIssues(body.manifest);
  if (issues.length) throw new HttpError(422, `invalid manifest: ${issues.join("; ")}`);
  const manifest = parseManifest(body.manifest);

  const tgz = Buffer.from(body.tarball, "base64");
  if (tgz.length === 0) throw new HttpError(400, "empty tarball");
  const digest = sha256(tgz);

  // The manifest inside the tarball is what actually gets installed — it must
  // agree with the submitted metadata.
  const embedded = await extractManifestFromTarball(tgz).catch((e: Error) => {
    throw new HttpError(400, `could not read tarball: ${e.message}`);
  });
  const embeddedIssues = manifestIssues(embedded);
  if (embeddedIssues.length) {
    throw new HttpError(422, `invalid embedded manifest: ${embeddedIssues.join("; ")}`);
  }
  const em = parseManifest(embedded);
  if (em.name !== manifest.name || em.version !== manifest.version) {
    throw new HttpError(422, "embedded manifest name/version does not match submission");
  }

  const existing = ctx.db.getPackage(manifest.name);
  if (existing && existing.publisher_id !== publisher.id) {
    throw new HttpError(403, `package "${manifest.name}" belongs to a different publisher`);
  }
  if (ctx.db.getVersion(manifest.name, manifest.version)) {
    throw new HttpError(409, `${manifest.name}@${manifest.version} already published`);
  }

  const blobPath = path.join(ctx.blobsDir, `${digest}.tgz`);
  fs.writeFileSync(blobPath, tgz);

  if (!existing) {
    ctx.db.insertPackage(manifest.name, publisher.id, manifest.description, manifest.version);
  } else {
    // latest = highest semver-ish by publish order; keep simple: newest upload wins.
    ctx.db.updatePackage(manifest.name, manifest.description, manifest.version);
  }
  ctx.db.insertVersion(manifest.name, manifest.version, JSON.stringify(manifest), digest, tgz.length);

  json(res, 201, {
    name: manifest.name,
    version: manifest.version,
    sha256: digest,
    url: `/packages/${encodeURIComponent(manifest.name)}`,
  });
}

async function route(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const method = req.method ?? "GET";

  if (method === "POST" && url.pathname === "/publishers") {
    const body = JSON.parse((await readBody(req)).toString("utf8")) as { name?: string };
    if (!body.name || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(body.name)) {
      throw new HttpError(400, "publisher name must be 1-64 chars [a-z0-9._-]");
    }
    try {
      const pub = ctx.db.createPublisher(body.name);
      json(res, 201, { name: pub.name, token: pub.token });
    } catch {
      throw new HttpError(409, `publisher "${body.name}" already exists`);
    }
    return;
  }

  if (method === "POST" && url.pathname === "/packages") {
    await handlePublish(ctx, req, res);
    return;
  }

  if (method === "GET" && url.pathname === "/packages") {
    const rows = ctx.db.listPackages();
    json(res, 200, {
      packages: rows.map((r) => ({
        name: r.name,
        description: r.description,
        latest: r.latest,
        versions: r.versions,
      })),
    });
    return;
  }

  if (method === "GET" && url.pathname === "/search") {
    const q = url.searchParams.get("q") ?? "";
    const rows = ctx.db.searchPackages(q);
    json(res, 200, {
      packages: rows.map((r) => ({
        name: r.name,
        description: r.description,
        latest: r.latest,
        versions: r.versions,
      })),
    });
    return;
  }

  if (method === "GET" && parts[0] === "packages" && parts.length === 2) {
    const pkg = ctx.db.getPackage(parts[1]);
    if (!pkg) throw new HttpError(404, `no such package: ${parts[1]}`);
    const versions = ctx.db.listVersions(parts[1]);
    json(res, 200, {
      name: pkg.name,
      description: pkg.description,
      latest: pkg.latest,
      versions: versions.map((v) => publicVersion(ctx, parts[1], v)),
    });
    return;
  }

  if (method === "GET" && parts[0] === "packages" && parts.length === 3 && parts[2] === "versions") {
    const pkg = ctx.db.getPackage(parts[1]);
    if (!pkg) throw new HttpError(404, `no such package: ${parts[1]}`);
    const versions = ctx.db.listVersions(parts[1]);
    json(res, 200, { name: parts[1], versions: versions.map((v) => v.version) });
    return;
  }

  if (method === "GET" && parts[0] === "packages" && parts.length === 3 && parts[2].endsWith(".tgz")) {
    const version = parts[2].slice(0, -4);
    const v = ctx.db.getVersion(parts[1], version);
    if (!v) throw new HttpError(404, `no such version: ${parts[1]}@${version}`);
    const blobPath = path.join(ctx.blobsDir, `${v.sha256}.tgz`);
    if (!fs.existsSync(blobPath)) throw new HttpError(500, "blob missing");
    const data = fs.readFileSync(blobPath);
    res.writeHead(200, {
      "content-type": "application/gzip",
      "content-length": data.length,
      "x-agentpack-sha256": v.sha256,
    });
    res.end(data);
    return;
  }

  if (method === "GET" && url.pathname === "/health") {
    json(res, 200, { ok: true });
    return;
  }

  throw new HttpError(404, `not found: ${method} ${url.pathname}`);
}

/**
 * Trust model: the registry stores and serves packages — authenticity comes from
 * publisher tokens and content hashes; the *security* boundary for the user is
 * the manifest + runtime enforcement in @agentpack/cli, not the registry.
 */
export function createRegistryServer(opts: RegistryOptions): Promise<{ server: http.Server; port: number; close: () => Promise<void> }> {
  fs.mkdirSync(opts.dataDir, { recursive: true });
  const blobsDir = path.join(opts.dataDir, "blobs");
  fs.mkdirSync(blobsDir, { recursive: true });
  const db = new RegistryDb(path.join(opts.dataDir, "registry.db"));
  const ctx: Ctx = { db, blobsDir };

  const server = http.createServer((req, res) => {
    route(ctx, req, res).catch((e) => {
      if (e instanceof HttpError) {
        json(res, e.status, { error: e.message });
      } else if (e instanceof SyntaxError) {
        json(res, 400, { error: "invalid JSON body" });
      } else {
        json(res, 500, { error: String(e?.message ?? e) });
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => {
              db.close();
              r();
            });
          }),
      });
    });
  });
}
