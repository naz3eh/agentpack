import * as tar from "tar";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const SKIP = new Set(["node_modules", ".git", ".DS_Store"]);

function* walk(dir: string, prefix = ""): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) yield* walk(path.join(dir, e.name), rel);
    else if (e.isFile()) yield rel;
    // symlinks skipped: a tarball must not smuggle in links to host paths
  }
}

export async function createTarball(dir: string): Promise<Buffer> {
  const files = [...walk(dir)];
  if (!files.includes("agentpack.json")) {
    throw new Error(`${dir} does not contain agentpack.json`);
  }
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agentpack-pack-")), "pkg.tgz");
  await tar.c({ file: tmp, cwd: dir, gzip: true, portable: true }, files);
  const buf = fs.readFileSync(tmp);
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  return buf;
}

export async function extractTarball(buf: Buffer, dest: string): Promise<void> {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agentpack-install-")), "pkg.tgz");
  fs.writeFileSync(tmp, buf);
  fs.mkdirSync(dest, { recursive: true });
  try {
    await tar.x({ file: tmp, cwd: dest });
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
}

export function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
