import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { policyFromManifest, type ManifestPolicy, type Manifest } from "@agentpack/schema";
import { startEgressProxy } from "./proxy.js";
import { startLlmBroker } from "./broker.js";
import { resolveInstalled } from "./install.js";
import { loadConfig } from "./config.js";

interface RuntimePolicy extends ManifestPolicy {
  installDir: string;
  localPorts: number[];
}

function expandFsPath(p: string): string {
  const home = os.homedir();
  if (p === "~" || p.startsWith("~/")) return path.join(home, p.slice(1));
  if (p === "$HOME" || p.startsWith("$HOME/")) return path.join(home, p.slice(5));
  return p;
}

/** Which env vars may reach the agent process: declared `env:` scopes only. */
export function agentEnv(manifest: Manifest, policy: RuntimePolicy): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? os.homedir(),
    AGENTPACK_AGENT: manifest.name,
    AGENTPACK_VERSION: manifest.version,
    AGENTPACK_POLICY_JSON: JSON.stringify(policy),
  };
  for (const name of policy.env) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

export interface RunResult {
  code: number;
}

/**
 * Execute an installed agent under its declared policy:
 *  - child process gets a filtered env (env: scopes only)
 *  - --require preload patches fs / net / dns / child_process / fetch
 *  - HTTP(S)_PROXY points at the built-in allowlist egress proxy
 *  - llm:call → AGENTPACK_LLM_URL broker (user key injected at the broker,
 *    models.preferred + per-run call/token caps enforced)
 */
export async function runAgent(spec: string, agentArgs: string[], opts: { onLog?: (m: string) => void } = {}): Promise<RunResult> {
  const { dir, manifest, name, version } = resolveInstalled(spec);
  const entrypoint = path.resolve(dir, manifest.entrypoint);

  const base = policyFromManifest(manifest);
  const cfg = loadConfig();
  const upstream = process.env.AGENTPACK_LLM_UPSTREAM ?? cfg.llm?.upstream;
  const apiKey = process.env.AGENTPACK_LLM_API_KEY ?? cfg.llm?.apiKey;

  const broker = base.llmCall
    ? await startLlmBroker({
        allowedModels: base.modelsPreferred,
        upstream,
        apiKey,
        maxCalls: process.env.AGENTPACK_LLM_MAX_CALLS ? Number(process.env.AGENTPACK_LLM_MAX_CALLS) : undefined,
        maxTokens: process.env.AGENTPACK_LLM_MAX_TOKENS ? Number(process.env.AGENTPACK_LLM_MAX_TOKENS) : undefined,
        onLog: opts.onLog,
      })
    : null;
  const proxy = await startEgressProxy(base.netDomains);

  const policy: RuntimePolicy = {
    ...base,
    fsRead: base.fsRead.map(expandFsPath),
    fsWrite: base.fsWrite.map(expandFsPath),
    installDir: dir,
    localPorts: [broker?.port, proxy.port].filter((p): p is number => typeof p === "number"),
  };

  const preload = path.join(__dirname, "preload.js");
  const proxyUrl = `http://127.0.0.1:${proxy.port}`;
  const env = agentEnv(manifest, policy);
  env.HTTP_PROXY = proxyUrl;
  env.HTTPS_PROXY = proxyUrl;
  env.http_proxy = proxyUrl;
  env.https_proxy = proxyUrl;
  env.NO_PROXY = "127.0.0.1,localhost";
  if (broker) env.AGENTPACK_LLM_URL = `http://127.0.0.1:${broker.port}`;

  opts.onLog?.(
    `running ${name}@${version} (scopes: ${manifest.scopes.join(", ") || "none"})` +
      (broker ? ` | llm broker on :${broker.port}${upstream ? ` -> ${upstream}` : " (mock mode)"}` : ""),
  );

  try {
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ["--require", preload, entrypoint, ...agentArgs], {
        env,
        cwd: dir,
        stdio: "inherit",
      });
      child.on("error", reject);
      child.on("exit", (c) => resolve(c ?? 1));
    });
    return { code };
  } finally {
    await broker?.close();
    await proxy.close();
  }
}
