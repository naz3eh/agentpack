import type { Manifest } from "@agentpack/schema";
import { parseScope } from "@agentpack/schema";
import { jevOr, type JevClient } from "@agentpack/jev";

export interface ReviewResult {
  verdict: "reasonable" | "over_permissioned" | "suspicious";
  reason: string;
  source: "jev" | "fallback";
}

const FLAG_LABELS = {
  none: "declared scopes match the described behavior",
  fs_write_mismatch: "requests filesystem write access the description doesn't imply",
  fs_broad: "requests broad filesystem access (fs:write:/ or fs:read:/)",
  net_broad: "requests unrestricted network access (net:*)",
  shell_exec: "requests arbitrary shell execution (shell:exec)",
  env_mismatch: "requests env vars unrelated to the described task",
  other: "other mismatch between description and scopes",
} as const;

type Flag = keyof typeof FLAG_LABELS;

const FILE_WORDS = ["file", "download", "folder", "directory", "disk", "receipt", "screenshot", "watch", "organize", "save", "export", "backup", "read", "write", "log"];
const NET_WORDS = ["web", "url", "http", "fetch", "api", "site", "page", "download", "scrape", "request", "online", "search", "summarize"];
const SHELL_WORDS = ["shell", "command", "script", "run", "execute", "cli", "subprocess", "terminal", "install"];
const LLM_WORDS = ["summar", "llm", "model", "gpt", "claude", "ai", "answer", "rewrite", "translate", "classif", "extract", "chat"];

function hasWord(desc: string, words: string[]): boolean {
  const d = desc.toLowerCase();
  return words.some((w) => d.includes(w));
}

/** Deterministic fallback review — no Jev key required. */
export function fallbackReview(manifest: Manifest): { verdict: ReviewResult["verdict"]; flag: Flag; reason: string } {
  const d = manifest.description.toLowerCase();
  const scopes = manifest.scopes.map(parseScope);
  const kinds = new Set(scopes.map((s) => s.kind));

  if (kinds.has("shell:exec") && kinds.has("net")) {
    return {
      verdict: "suspicious",
      flag: "shell_exec",
      reason: `suspicious: combines shell:exec with network access — ${FLAG_LABELS.shell_exec}`,
    };
  }
  if (scopes.some((s) => (s.kind === "fs:write" || s.kind === "fs:read") && s.value === "/")) {
    return {
      verdict: "over_permissioned",
      flag: "fs_broad",
      reason: `over_permissioned: ${FLAG_LABELS.fs_broad}`,
    };
  }
  if (kinds.has("fs:write") && !hasWord(d, FILE_WORDS)) {
    return {
      verdict: "over_permissioned",
      flag: "fs_write_mismatch",
      reason: `over_permissioned: ${FLAG_LABELS.fs_write_mismatch}`,
    };
  }
  if (kinds.has("net") && scopes.some((s) => s.kind === "net" && s.value === "*") && !hasWord(d, NET_WORDS)) {
    return {
      verdict: "over_permissioned",
      flag: "net_broad",
      reason: `over_permissioned: ${FLAG_LABELS.net_broad} for "${manifest.description}"`,
    };
  }
  if (kinds.has("shell:exec") && !hasWord(d, SHELL_WORDS)) {
    return {
      verdict: "suspicious",
      flag: "shell_exec",
      reason: `suspicious: ${FLAG_LABELS.shell_exec} but description doesn't mention commands`,
    };
  }
  if (kinds.has("env") && scopes.filter((s) => s.kind === "env").some((s) => /key|token|secret|pass/i.test(s.value)) && !hasWord(d, [...LLM_WORDS, ...NET_WORDS])) {
    return {
      verdict: "over_permissioned",
      flag: "env_mismatch",
      reason: `over_permissioned: ${FLAG_LABELS.env_mismatch} (credential-shaped env vars)`,
    };
  }
  return { verdict: "reasonable", flag: "none", reason: "reasonable: scopes match the description" };
}

/**
 * Jev permission sanity check: manifest description + scopes → closed verdict
 * {reasonable, over_permissioned, suspicious} + a flag the CLI turns into a
 * short human-readable reason.
 */
export async function reviewManifest(
  manifest: Manifest,
  client: JevClient | null,
  extra?: { entrypointSnippet?: string },
): Promise<ReviewResult> {
  const state: Record<string, unknown> = {
    name: manifest.name,
    description: manifest.description,
    requestedScopes: manifest.scopes,
    models: manifest.models.preferred,
  };
  if (extra?.entrypointSnippet) state.entrypointSnippet = extra.entrypointSnippet;

  const { value, source } = await jevOr(
    client,
    async (c) => {
      const verdict = await c.choose(
        state,
        "verdict",
        "Does this agent's manifest over-request permissions relative to its description? " +
          "Judge whether each declared scope is plausibly needed for what the agent claims to do.",
        {
          reasonable: "Every declared scope is plausibly required by the described behavior.",
          over_permissioned:
            "One or more scopes exceed what the description needs (e.g. fs:write or net:* for a text-only tool).",
          suspicious:
            "The scope pattern suggests possible abuse (e.g. shell:exec combined with network, credential env vars unrelated to the task).",
        },
      );
      const flag = await c.choose(
        state,
        "flag",
        "Which single scope issue is most relevant? Answer 'none' if the verdict was reasonable.",
        FLAG_LABELS,
      );
      return { verdict: verdict.choice, flag: flag.choice as Flag };
    },
    () => fallbackReview(manifest),
  );

  const verdict = (["reasonable", "over_permissioned", "suspicious"].includes(value.verdict)
    ? value.verdict
    : "reasonable") as ReviewResult["verdict"];
  const flag = (value.flag in FLAG_LABELS ? value.flag : "other") as Flag;
  const reason =
    verdict === "reasonable"
      ? "reasonable: scopes match the description"
      : `${verdict}: ${FLAG_LABELS[flag]}`;
  return { verdict, reason, source };
}
