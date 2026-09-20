#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { parseManifest, parseScope } from "@agentpack/schema";
import { getJevClient } from "@agentpack/jev";
import { createRegistryServer } from "@agentpack/registry";
import { resolveRegistry, savePublisherToken, publisherToken, configPath } from "./config.js";
import { installPackage, fetchPackageMeta, listInstalled, parseNameVersion } from "./install.js";
import { publishPackage } from "./publish.js";
import { runAgent } from "./run.js";
import { reviewManifest } from "./review.js";
import { findAgent, type CatalogEntry } from "./find.js";
import { suggestScopes } from "./initcmd.js";

const USAGE = `agentpack — install and run AI agents with declared permissions

usage:
  agentpack init <dir> [--describe "what it does"]     scaffold a new agent
  agentpack publisher create <name> [--registry URL]   mint a publisher token (saved to config)
  agentpack publish <dir> [--registry URL] [--publisher NAME | --token T]
  agentpack install <name>[@ver] [--registry URL] [-y] install to ~/.agentpack/agents
  agentpack run <name>[@ver] [-- args...]              run under declared scopes
  agentpack find "<query>" [--registry URL]            Jev picks the best catalog match
  agentpack review <name|dir> [--registry URL]         Jev permission sanity check
  agentpack list                                       installed agents
  agentpack registry [--port N] [--data DIR]           run a local registry
  agentpack help

env: TYPESAFE_API_KEY (Jev decisions), AGENTPACK_REGISTRY, AGENTPACK_TOKEN,
     AGENTPACK_LLM_UPSTREAM, AGENTPACK_LLM_API_KEY, AGENTPACK_HOME
`;

function arg(flags: string[], name: string): string | undefined {
  const i = flags.indexOf(name);
  return i >= 0 && i + 1 < flags.length ? flags[i + 1] : undefined;
}

function hasFlag(flags: string[], name: string): boolean {
  return flags.includes(name);
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const ans = await new Promise<string>((r) => rl.question(`${question} [y/N] `, r));
    return /^y(es)?$/i.test(ans.trim());
  } finally {
    rl.close();
  }
}

function warnDangerous(scopes: string[]): void {
  const dangerous = scopes.filter((s) => parseScope(s).dangerous);
  if (dangerous.length) {
    console.error(`\n⚠  WARNING — this agent declares dangerous scope(s): ${dangerous.join(", ")}`);
    console.error("   shell:exec lets the agent run ANY command on your machine. Review the code first.\n");
  }
}

async function cmdInit(args: string[]): Promise<void> {
  const dir = args[0];
  if (!dir) throw new Error("usage: agentpack init <dir> [--describe \"...\"]");
  const describe = arg(args, "--describe");
  const name = path.basename(path.resolve(dir)).toLowerCase().replace(/[^a-z0-9._-]/g, "-");

  let scopes: string[] = [];
  let source: string | null = null;
  if (describe) {
    const client = getJevClient();
    const s = await suggestScopes(describe, client);
    scopes = s.scopes.map((sc) => sc.replace(/\$HOME|~/, process.env.HOME ?? "~"));
    source = s.source;
  }
  const wantsLlm = scopes.includes("llm:call");

  const manifest = {
    name,
    version: "0.1.0",
    description: describe ?? "TODO: describe your agent",
    entrypoint: "index.js",
    runtime: "node20",
    scopes,
    models: { preferred: wantsLlm ? ["gpt-4o-mini"] : [] },
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "agentpack.json"), JSON.stringify(manifest, null, 2) + "\n");
  fs.writeFileSync(
    path.join(dir, "index.js"),
    `// ${name} — agentpack entrypoint
// Declared scopes are enforced at run time; edit agentpack.json to change them.
const main = async () => {
  console.log("hello from ${name}");
  ${wantsLlm ? `
  // call the brokered LLM (key injected by the agentpack broker — never visible here):
  const res = await fetch(process.env.AGENTPACK_LLM_URL + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "${manifest.models.preferred[0] ?? "gpt-4o-mini"}", messages: [{ role: "user", content: "Say hi." }] }),
  });
  console.log(await res.json());` : ""}
};
main().catch((e) => { console.error(e); process.exit(1); });
`,
  );
  console.log(`created ${dir}/agentpack.json${source ? ` (scopes picked by ${source === "jev" ? "Jev" : "keyword fallback"})` : ""}`);
  console.log(`  edit it, then: agentpack publish ${dir}`);
}

async function cmdPublisherCreate(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) throw new Error("usage: agentpack publisher create <name>");
  const registry = resolveRegistry(arg(args, "--registry"));
  const res = (await (await import("./http.js")).apiJson("POST", `${registry}/publishers`, { name })) as {
    name: string;
    token: string;
  };
  savePublisherToken(res.name, res.token);
  console.log(`publisher "${res.name}" created — token saved to ${configPath()}`);
  console.log(res.token);
}

async function cmdPublish(args: string[]): Promise<void> {
  const dir = args[0] ?? ".";
  const registry = resolveRegistry(arg(args, "--registry"));
  const publisher = arg(args, "--publisher");
  const token = arg(args, "--token") ?? process.env.AGENTPACK_TOKEN ?? (publisher ? publisherToken(publisher) : undefined);
  if (!token) {
    throw new Error("no publisher token: pass --token, set AGENTPACK_TOKEN, or --publisher <name> (see: agentpack publisher create)");
  }
  const res = await publishPackage(dir, registry, token);
  console.log(`published ${res.name}@${res.version} (${res.sha256.slice(0, 12)}…) -> ${registry}`);
}

async function reviewAndGate(
  manifest: Parameters<typeof reviewManifest>[0],
  opts: { yes: boolean; entrypointDir?: string },
): Promise<void> {
  const client = getJevClient();
  let snippet: string | undefined;
  if (opts.entrypointDir) {
    const ep = path.join(opts.entrypointDir, manifest.entrypoint);
    if (fs.existsSync(ep)) snippet = fs.readFileSync(ep, "utf8").slice(0, 4000);
  }
  const r = await reviewManifest(manifest, client, { entrypointSnippet: snippet });
  warnDangerous(manifest.scopes);
  if (r.verdict === "reasonable") {
    console.error(`review (${r.source}): ${r.reason}`);
    return;
  }
  console.error(`review (${r.source}): ${r.reason}`);
  console.error(`   scopes: ${manifest.scopes.join(", ")}`);
  if (opts.yes) {
    console.error(`   proceeding anyway (--yes)`);
    return;
  }
  if (!(await confirm("Install anyway?"))) {
    throw new Error("install aborted by permission review");
  }
}

async function cmdInstall(args: string[]): Promise<void> {
  const spec = args[0];
  if (!spec) throw new Error("usage: agentpack install <name>[@ver]");
  const registry = resolveRegistry(arg(args, "--registry"));
  const yes = hasFlag(args, "-y") || hasFlag(args, "--yes");

  const { name, version } = parseNameVersion(spec);
  const meta = await fetchPackageMeta(registry, name);
  const v = meta.versions.find((x) => x.version === (version ?? meta.latest));
  if (!v) throw new Error(`no such version: ${name}@${version ?? meta.latest}`);

  await reviewAndGate(v.manifest, { yes });
  const res = await installPackage(registry, spec);
  console.log(`installed ${res.name}@${res.version} -> ${res.dir}`);
  console.log(`  run it: agentpack run ${res.name}`);
}

async function cmdRun(args: string[]): Promise<void> {
  const spec = args[0];
  if (!spec) throw new Error("usage: agentpack run <name>[@ver] [-- args]");
  const rest = args.slice(1);
  const dd = rest.indexOf("--");
  const agentArgs = dd >= 0 ? rest.slice(dd + 1) : [];
  const { code } = await runAgent(spec, agentArgs, { onLog: (m) => console.error(`[agentpack] ${m}`) });
  process.exitCode = code;
}

async function cmdFind(args: string[]): Promise<void> {
  const query = args.filter((a) => !a.startsWith("-")).join(" ");
  if (!query) throw new Error("usage: agentpack find \"<query>\"");
  const registry = resolveRegistry(arg(args, "--registry"));
  const res = (await (await import("./http.js")).apiJson("GET", `${registry}/packages`)) as {
    packages: CatalogEntry[];
  };
  const { name, source } = await findAgent(query, res.packages, getJevClient());
  if (!name) {
    console.log("no matching agent in the catalog");
    return;
  }
  console.log(`${name} (${source === "jev" ? "picked by Jev" : "keyword match"})`);
  console.log(`  install it: agentpack install ${name}`);
}

async function cmdReview(args: string[]): Promise<void> {
  const target = args[0];
  if (!target) throw new Error("usage: agentpack review <name|dir>");
  const registry = resolveRegistry(arg(args, "--registry"));
  let manifest;
  let entrypointSnippet: string | undefined;
  if (fs.existsSync(path.join(target, "agentpack.json"))) {
    manifest = parseManifest(JSON.parse(fs.readFileSync(path.join(target, "agentpack.json"), "utf8")));
    const ep = path.join(target, manifest.entrypoint);
    if (fs.existsSync(ep)) entrypointSnippet = fs.readFileSync(ep, "utf8").slice(0, 4000);
  } else {
    const meta = await fetchPackageMeta(registry, target);
    const latest = meta.versions.find((v) => v.version === meta.latest) ?? meta.versions[0];
    manifest = latest.manifest;
  }
  const r = await reviewManifest(manifest, getJevClient(), { entrypointSnippet });
  warnDangerous(manifest.scopes);
  console.log(`${r.verdict} (${r.source}): ${r.reason}`);
  console.log(`  scopes: ${manifest.scopes.join(", ") || "none"}`);
}

async function cmdRegistry(args: string[]): Promise<void> {
  const port = Number(arg(args, "--port") ?? process.env.AGENTPACK_REGISTRY_PORT ?? 4873);
  const data = arg(args, "--data") ?? process.env.AGENTPACK_REGISTRY_DATA ?? path.join(process.cwd(), ".agentpack-data");
  const { port: bound } = await createRegistryServer({ port, dataDir: path.resolve(data) });
  console.log(`agentpack registry on http://127.0.0.1:${bound} (data: ${path.resolve(data)})`);
  await new Promise(() => {});
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "init":
      return cmdInit(args);
    case "publisher":
      if (args[0] === "create") return cmdPublisherCreate(args.slice(1));
      throw new Error("usage: agentpack publisher create <name>");
    case "publish":
      return cmdPublish(args);
    case "install":
      return cmdInstall(args);
    case "run":
      return cmdRun(args);
    case "find":
      return cmdFind(args);
    case "review":
      return cmdReview(args);
    case "list":
      for (const n of listInstalled()) console.log(n);
      return;
    case "registry":
      return cmdRegistry(args);
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(USAGE);
      return;
    default:
      console.error(`unknown command: ${cmd}\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(`agentpack: ${e.message ?? e}`);
  process.exitCode = 1;
});
