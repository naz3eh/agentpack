import { z } from "zod";

/**
 * Closed scope vocabulary. Anything outside this grammar is invalid.
 *
 *   net:<domain>          outbound HTTP limited to <domain> (+ subdomains);
 *                         the literal `net:*` allows any domain
 *   fs:read:<path>        read-only file access under a path prefix
 *   fs:write:<path>       read+write file access under a path prefix
 *   env:<NAME>            may read only the listed env var
 *   llm:call              may call the brokered LLM endpoint
 *   shell:exec            may spawn arbitrary processes (DANGEROUS)
 */
export const SCOPE_KINDS = [
  "net",
  "fs:read",
  "fs:write",
  "env",
  "llm:call",
  "shell:exec",
] as const;

export type ScopeKind = (typeof SCOPE_KINDS)[number];

/** Scopes that can hand the agent broad control; trigger hard warnings. */
export const DANGEROUS_SCOPES: ReadonlySet<ScopeKind> = new Set(["shell:exec"]);

const DOMAIN_RE = /^(?:\*|[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*|\d{1,3}(?:\.\d{1,3}){3})$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ParsedScope {
  kind: ScopeKind;
  /** e.g. domain for net, path prefix for fs:*, var name for env. Empty for llm:call / shell:exec. */
  value: string;
  raw: string;
  dangerous: boolean;
}

/** Parse a single scope string; throws on anything outside the vocabulary. */
export function parseScope(raw: string): ParsedScope {
  if (raw === "llm:call") {
    return { kind: "llm:call", value: "", raw, dangerous: false };
  }
  if (raw === "shell:exec") {
    return { kind: "shell:exec", value: "", raw, dangerous: true };
  }
  const m = /^(net|fs:read|fs:write|env):(.+)$/.exec(raw);
  if (!m) {
    throw new Error(
      `invalid scope "${raw}": must be net:<domain>, fs:read:<path>, fs:write:<path>, env:<NAME>, llm:call, or shell:exec`,
    );
  }
  const kind = m[1] as ScopeKind;
  const value = m[2];
  switch (kind) {
    case "net":
      if (!DOMAIN_RE.test(value)) {
        throw new Error(`invalid scope "${raw}": "${value}" is not a valid domain or "*"'`);
      }
      break;
    case "env":
      if (!ENV_NAME_RE.test(value)) {
        throw new Error(`invalid scope "${raw}": "${value}" is not a valid env var name`);
      }
      break;
    case "fs:read":
    case "fs:write":
      if (!value.startsWith("/")) {
        throw new Error(`invalid scope "${raw}": fs paths must be absolute (start with /)`);
      }
      break;
  }
  return { kind, value, raw, dangerous: DANGEROUS_SCOPES.has(kind) };
}

export function isValidScope(raw: string): boolean {
  try {
    parseScope(raw);
    return true;
  } catch {
    return false;
  }
}

const scopeString = z
  .string()
  .min(1)
  .refine(isValidScope, (s) => ({ message: `invalid scope: ${s}` }));

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// Semver-lite: MAJOR.MINOR.PATCH with optional prerelease/build.
const VERSION_RE =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export const manifestSchema = z
  .object({
    name: z
      .string()
      .regex(NAME_RE, "name must be lowercase, 1-64 chars, [a-z0-9._-]"),
    version: z
      .string()
      .regex(VERSION_RE, "version must be MAJOR.MINOR.PATCH semver"),
    description: z.string().min(1).max(500),
    entrypoint: z
      .string()
      .min(1)
      .refine((p) => !p.startsWith("/") && !p.includes(".."), {
        message: "entrypoint must be a relative path inside the package",
      }),
    runtime: z.literal("node20"),
    scopes: z.array(scopeString).default([]),
    models: z
      .object({
        preferred: z.array(z.string().min(1)).default([]),
      })
      .default({ preferred: [] }),
  })
  .strict();

export type Manifest = z.infer<typeof manifestSchema>;

export interface ManifestPolicy {
  /** null = all domains allowed (net:*), otherwise the domain allowlist. */
  netDomains: string[] | null;
  fsRead: string[];
  fsWrite: string[];
  env: string[];
  llmCall: boolean;
  shellExec: boolean;
  modelsPreferred: string[];
}

/** Compile a validated manifest into the runtime policy object. */
export function policyFromManifest(m: Manifest): ManifestPolicy {
  const p: ManifestPolicy = {
    netDomains: [],
    fsRead: [],
    fsWrite: [],
    env: [],
    llmCall: false,
    shellExec: false,
    modelsPreferred: m.models.preferred,
  };
  for (const raw of m.scopes) {
    const s = parseScope(raw);
    switch (s.kind) {
      case "net":
        if (s.value === "*") p.netDomains = null;
        else if (p.netDomains !== null) p.netDomains.push(s.value.toLowerCase());
        break;
      case "fs:read":
        p.fsRead.push(s.value);
        break;
      case "fs:write":
        p.fsWrite.push(s.value);
        break;
      case "env":
        p.env.push(s.value);
        break;
      case "llm:call":
        p.llmCall = true;
        break;
      case "shell:exec":
        p.shellExec = true;
        break;
    }
  }
  return p;
}

export function parseManifest(data: unknown): Manifest {
  return manifestSchema.parse(data);
}

export function manifestIssues(data: unknown): string[] {
  const res = manifestSchema.safeParse(data);
  if (res.success) return [];
  return res.error.issues.map(
    (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
  );
}

/** Domains match exactly or as subdomains: example.com covers api.example.com. */
export function domainAllowed(host: string, allowlist: string[] | null): boolean {
  if (allowlist === null) return true;
  const h = host.toLowerCase();
  return allowlist.some((d) => h === d || h.endsWith("." + d));
}
