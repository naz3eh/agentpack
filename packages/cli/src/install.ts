import fs from "node:fs";
import path from "node:path";
import { parseManifest, type Manifest } from "@agentpack/schema";
import { apiJson, apiDownload } from "./http.js";
import { extractTarball, sha256 } from "./tarball.js";
import { agentsDir, installedDir } from "./config.js";

export interface PackageMeta {
  name: string;
  description: string;
  latest: string;
  versions: {
    version: string;
    sha256: string;
    manifest: Manifest;
    dist: { tarball: string; sha256: string };
  }[];
}

export function parseNameVersion(spec: string): { name: string; version?: string } {
  const i = spec.lastIndexOf("@");
  if (i > 0) return { name: spec.slice(0, i), version: spec.slice(i + 1) };
  return { name: spec };
}

export async function fetchPackageMeta(registry: string, name: string): Promise<PackageMeta> {
  return (await apiJson("GET", `${registry}/packages/${encodeURIComponent(name)}`)) as PackageMeta;
}

export async function installPackage(
  registry: string,
  spec: string,
): Promise<{ name: string; version: string; dir: string; manifest: Manifest }> {
  const { name, version } = parseNameVersion(spec);
  const meta = await fetchPackageMeta(registry, name);
  const wanted = version ?? meta.latest;
  const v = meta.versions.find((x) => x.version === wanted);
  if (!v) throw new Error(`no such version: ${name}@${wanted}`);

  const { buf } = await apiDownload(`${registry}${v.dist.tarball}`);
  const digest = sha256(buf);
  if (digest !== v.sha256) {
    throw new Error(`integrity check failed: tarball sha256 ${digest} != registry ${v.sha256}`);
  }

  const dir = installedDir(name, v.version);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  await extractTarball(buf, dir);

  // the manifest inside the tarball is authoritative — it must agree with registry metadata
  const embedded = parseManifest(JSON.parse(fs.readFileSync(path.join(dir, "agentpack.json"), "utf8")));
  if (embedded.name !== name || embedded.version !== v.version) {
    throw new Error("embedded manifest does not match registry metadata");
  }

  // `latest` convenience link
  const latestLink = installedDir(name);
  fs.rmSync(latestLink, { recursive: true, force: true });
  try {
    fs.symlinkSync(v.version, latestLink);
  } catch {
    // symlink unavailable → fall back to a marker file
    fs.mkdirSync(latestLink, { recursive: true });
    fs.writeFileSync(path.join(latestLink, ".resolved"), v.version);
  }

  fs.writeFileSync(
    path.join(dir, ".installed.json"),
    JSON.stringify({ registry, sha256: v.sha256, installedAt: new Date().toISOString() }, null, 2),
  );
  return { name, version: v.version, dir, manifest: embedded };
}

export function resolveInstalled(spec: string): { dir: string; manifest: Manifest; name: string; version: string } {
  const { name, version } = parseNameVersion(spec);
  let dir: string;
  let resolvedVersion = version ?? "";
  if (version) {
    dir = installedDir(name, version);
  } else {
    dir = installedDir(name);
    const marker = path.join(dir, ".resolved");
    if (!fs.existsSync(dir)) throw new Error(`not installed: ${name} (try: agentpack install ${name})`);
    if (fs.existsSync(marker)) {
      resolvedVersion = fs.readFileSync(marker, "utf8").trim();
      dir = installedDir(name, resolvedVersion);
    } else {
      const stat = fs.lstatSync(dir);
      if (stat.isSymbolicLink()) {
        resolvedVersion = fs.readlinkSync(dir);
        dir = installedDir(name, resolvedVersion);
      } else if (stat.isDirectory() && fs.existsSync(path.join(dir, "agentpack.json"))) {
        resolvedVersion = "latest";
      } else {
        throw new Error(`not installed: ${name}`);
      }
    }
  }
  const manifestPath = path.join(dir, "agentpack.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`not installed: ${spec} (try: agentpack install ${name})`);
  const manifest = parseManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
  return { dir, manifest, name, version: resolvedVersion || manifest.version };
}

export function listInstalled(): string[] {
  const base = agentsDir();
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}
