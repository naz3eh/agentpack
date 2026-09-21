import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CliConfig {
  registry?: string;
  /** publisher name -> token */
  publishers?: Record<string, { token: string }>;
  llm?: {
    /** e.g. "https://api.openai.com/v1" — the broker appends /chat/completions. */
    upstream?: string;
    /** The USER's provider key — injected by the broker, never given to agent code. */
    apiKey?: string;
  };
}

export function agentpackHome(): string {
  return process.env.AGENTPACK_HOME ?? path.join(os.homedir(), ".agentpack");
}

export function configPath(): string {
  return path.join(agentpackHome(), "config.json");
}

export function loadConfig(): CliConfig {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8")) as CliConfig;
  } catch {
    return {};
  }
}

export function saveConfig(cfg: CliConfig): void {
  fs.mkdirSync(agentpackHome(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function resolveRegistry(flag?: string): string {
  const reg = flag ?? process.env.AGENTPACK_REGISTRY ?? loadConfig().registry ?? "http://127.0.0.1:4873";
  return reg.replace(/\/+$/, "");
}

export function agentsDir(): string {
  return path.join(agentpackHome(), "agents");
}

export function installedDir(name: string, version?: string): string {
  return path.join(agentsDir(), name, version ?? "latest");
}

export function savePublisherToken(publisher: string, token: string): void {
  const cfg = loadConfig();
  cfg.publishers = { ...cfg.publishers, [publisher]: { token } };
  saveConfig(cfg);
}

export function publisherToken(publisher: string): string | undefined {
  return loadConfig().publishers?.[publisher]?.token;
}
