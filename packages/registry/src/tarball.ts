import * as tar from "tar";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Extract `agentpack.json` from a gzipped tarball buffer.
 * The tarball may nest the manifest one directory deep (npm-style `package/`).
 */
export async function extractManifestFromTarball(buf: Buffer): Promise<unknown> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpack-unpack-"));
  try {
    const tgz = path.join(tmp, "pkg.tgz");
    fs.writeFileSync(tgz, buf);
    const out = path.join(tmp, "out");
    fs.mkdirSync(out);
    await tar.x({ file: tgz, cwd: out });
    for (const candidate of [
      path.join(out, "agentpack.json"),
      ...fs
        .readdirSync(out, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(out, d.name, "agentpack.json")),
    ]) {
      if (fs.existsSync(candidate)) {
        return JSON.parse(fs.readFileSync(candidate, "utf8"));
      }
    }
    throw new Error("tarball does not contain an agentpack.json");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
