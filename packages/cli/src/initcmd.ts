import { jevOr, type JevClient } from "@agentpack/jev";
import { SCOPE_KINDS } from "@agentpack/schema";

export interface ScopeSuggestion {
  scopes: string[];
  source: "jev" | "fallback";
}

const CAPABILITIES: { scope: string; question: string; keywords: RegExp }[] = [
  {
    scope: "net:*",
    question: "Does the described agent need outbound network/HTTP access?",
    keywords: /web|url|http|fetch|api|site|page|scrape|download|online|search|request/i,
  },
  {
    scope: "fs:read:",
    question: "Does the described agent need to read files from the filesystem?",
    keywords: /file|folder|directory|download|receipt|screenshot|document|read|log/i,
  },
  {
    scope: "fs:write:",
    question: "Does the described agent need to write or modify files?",
    keywords: /write|save|export|organize|move|rename|backup|create|modify|generate file/i,
  },
  {
    scope: "env:",
    question: "Does the described agent need to read environment variables?",
    keywords: /env var|environment|api key|token|config/i,
  },
  {
    scope: "llm:call",
    question: "Does the described agent need to call an LLM?",
    keywords: /llm|summar|gpt|claude|ai |answer|rewrite|translate|classif|extract|model/i,
  },
  {
    scope: "shell:exec",
    question: "Does the described agent need to run shell commands or other programs?",
    keywords: /shell|command|execute|subprocess|terminal|run program|install/i,
  },
];

function fallbackSuggest(description: string): string[] {
  const scopes: string[] = [];
  for (const cap of CAPABILITIES) {
    if (!cap.keywords.test(description)) continue;
    if (cap.scope === "net:*") scopes.push("net:*");
    else if (cap.scope === "fs:read:") scopes.push(`fs:read:${detectPath(description) ?? "$HOME"}`);
    else if (cap.scope === "fs:write:") scopes.push(`fs:write:${detectPath(description) ?? "$HOME"}`);
    else if (cap.scope === "env:") scopes.push(...detectEnvVars(description).map((v) => `env:${v}`));
    else scopes.push(cap.scope);
  }
  return scopes;
}

function detectPath(description: string): string | null {
  const m = /\b(downloads?|documents?|desktop|pictures?|music|videos?)\b/i.exec(description);
  return m ? `$HOME/${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()}` : null;
}

function detectEnvVars(description: string): string[] {
  const found = new Set<string>();
  for (const m of description.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) found.add(m[0]);
  return found.size ? [...found] : ["AGENT_CONFIG"];
}

/**
 * `agentpack init --describe` → Jev picks scope capabilities from the closed
 * vocabulary (one closed choice per capability), then maps them to concrete
 * draft scopes the user edits.
 */
export async function suggestScopes(
  description: string,
  client: JevClient | null,
): Promise<ScopeSuggestion> {
  const { value, source } = await jevOr(
    client,
    async (c) => {
      const yesNo = { yes: "The capability is plausibly needed.", no: "Not needed." };
      const picked: string[] = [];
      for (const cap of CAPABILITIES) {
        const r = await c.choose(
          { description },
          cap.scope,
          cap.question,
          yesNo,
        );
        if (r.choice === "yes") {
          if (cap.scope === "net:*") picked.push("net:*");
          else if (cap.scope === "fs:read:") picked.push(`fs:read:${detectPath(description) ?? "$HOME"}`);
          else if (cap.scope === "fs:write:") picked.push(`fs:write:${detectPath(description) ?? "$HOME"}`);
          else if (cap.scope === "env:") {
            const vars = detectEnvVars(description);
            picked.push(...vars.map((v) => `env:${v}`));
          } else picked.push(cap.scope);
        }
      }
      return picked;
    },
    () => fallbackSuggest(description),
  );

  // validate against the closed vocabulary — never emit a scope that wouldn't parse
  const clean = value.filter((s) => {
    const expanded = s.replace("$HOME", "/home/user");
    return SCOPE_KINDS.some((k) => expanded === k || expanded.startsWith(k + ":"));
  });
  return { scopes: clean, source };
}
