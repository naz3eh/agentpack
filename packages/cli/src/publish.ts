import fs from "node:fs";
import path from "node:path";
import { parseManifest } from "@agentpack/schema";
import { apiJson } from "./http.js";
import { createTarball } from "./tarball.js";

export async function publishPackage(
  dir: string,
  registry: string,
  token: string,
): Promise<{ name: string; version: string; sha256: string }> {
  const manifestPath = path.join(dir, "agentpack.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`no agentpack.json in ${dir} (run: agentpack init ${dir})`);
  }
  const manifest = parseManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));

  const entry = path.join(dir, manifest.entrypoint);
  if (!fs.existsSync(entry)) {
    throw new Error(`entrypoint not found: ${manifest.entrypoint} (under ${dir})`);
  }

  const tgz = await createTarball(dir);
  const res = (await apiJson(
    "POST",
    `${registry}/packages`,
    { manifest, tarball: tgz.toString("base64") },
    { authorization: `Bearer ${token}` },
  )) as { name: string; version: string; sha256: string };
  return res;
}
