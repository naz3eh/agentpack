/**
 * agentpack policy preload — loaded into the agent process via `node --require`.
 *
 * What it does:
 *   1. Filters process.env down to the manifest's declared `env:` scopes
 *      (plus a minimal runtime passthrough set).
 *   2. Patches fs/fs.promises so reads/writes outside the declared
 *      `fs:read:`/`fs:write:` prefixes throw EPERM.
 *   3. Patches http/https/fetch/net/tls/dns so outbound connections to
 *      non-declared domains are refused (belt & suspenders alongside the
 *      HTTP_PROXY/HTTPS_PROXY egress proxy).
 *   4. Denies child_process entirely unless `shell:exec` is declared.
 *
 * Honest limits (see README): this is runtime patching inside a normal Node
 * process, NOT a kernel sandbox. A determined agent can still escape via
 * native addons, raw syscalls through ffi, or side channels. It exists to
 * make accidental or lazy overreach fail loudly — and it does.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface Policy {
  netDomains: string[] | null; // null = allow all
  fsRead: string[];
  fsWrite: string[];
  env: string[];
  llmCall: boolean;
  shellExec: boolean;
  installDir: string;
  /** 127.0.0.1 ports the runtime itself owns (LLM broker, egress proxy). */
  localPorts: number[];
}

const policy: Policy = JSON.parse(process.env.AGENTPACK_POLICY_JSON ?? "{}");

function deny(what: string): Error {
  const err = new Error(
    `agentpack: ${what} blocked by manifest policy (declare the scope in agentpack.json to allow it)`,
  );
  (err as NodeJS.ErrnoException).code = "EPERM";
  return err;
}

/* ---------------------------------- env ---------------------------------- */

// Wiring vars the runtime itself injects + minimal session basics.
const ENV_PASSTHROUGH = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "TERM",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  "WINDIR",
  // agentpack runtime wiring
  "AGENTPACK_POLICY_JSON",
  "AGENTPACK_LLM_URL",
  "AGENTPACK_AGENT",
  "AGENTPACK_VERSION",
]);

const envAllow = new Set([...ENV_PASSTHROUGH, ...policy.env]);
for (const key of Object.keys(process.env)) {
  if (!envAllow.has(key) && !key.startsWith("XDG_")) {
    delete process.env[key];
  }
}

/* ----------------------------------- fs ---------------------------------- */

const readPaths = [...policy.fsRead, ...policy.fsWrite, policy.installDir].map((p) =>
  path.resolve(p),
);
const writePaths = policy.fsWrite.map((p) => path.resolve(p));

function toPath(p: unknown): string | null {
  if (typeof p === "number") return "\0fd"; // fd args were already gated by open()
  if (typeof p === "string") return p;
  if (p instanceof URL) {
    try {
      return fileURLToPath(p);
    } catch {
      return null;
    }
  }
  if (Buffer.isBuffer(p)) return p.toString("utf8");
  return null;
}

function pathAllowed(p: unknown, write: boolean): boolean {
  const raw = toPath(p);
  if (raw === null) return false;
  if (raw === "\0fd") return true; // numeric fd: permission decided at open()
  const abs = path.resolve(raw);
  const list = write ? writePaths : readPaths;
  return list.some((prefix) => abs === prefix || abs.startsWith(prefix + path.sep));
}

const OPEN_WRITE_FLAGS = /[wax+]/;

function patchFsModule(mod: Record<string, unknown>): void {
  const reads = [
    "stat", "lstat", "readdir", "readFile", "readlink", "realpath",
    "createReadStream", "opendir", "statfs", "readv", "watch", "watchFile",
    "unwatchFile", "openAsBlob", "glob",
  ];
  const writes = [
    "writeFile", "appendFile", "mkdir", "rm", "rmdir", "unlink",
    "truncate", "chmod", "chown", "lchmod", "lchown", "utimes", "lutimes",
    "mkdtemp", "createWriteStream", "writev", "write",
  ];

  const wrap =
    (kind: "read" | "write", name: string) =>
    (orig: unknown): unknown => {
      if (typeof orig !== "function") return orig;
      return function (this: unknown, ...args: unknown[]) {
        if (!pathAllowed(args[0], kind === "write")) {
          // async (last arg is a callback) → error through the callback; else throw
          const cb = args[args.length - 1];
          if (typeof cb === "function" && !name.endsWith("Sync") && !name.startsWith("create")) {
            const e = deny(`fs ${kind} of ${String(args[0])}`);
            process.nextTick(() => (cb as (...a: unknown[]) => void)(e));
            return;
          }
          throw deny(`fs ${kind} of ${String(args[0])}`);
        }
        return (orig as (...a: unknown[]) => unknown).apply(this, args);
      };
    };

  const wrapOpen = (orig: unknown): unknown => {
    if (typeof orig !== "function") return orig;
    return function (this: unknown, ...args: unknown[]) {
      const flags = typeof args[1] === "string" ? args[1] : typeof args[1] === "number" ? args[1] : "r";
      const write = typeof flags === "number" || OPEN_WRITE_FLAGS.test(flags);
      if (!pathAllowed(args[0], write)) {
        const cb = args[args.length - 1];
        if (typeof cb === "function" && !(orig as { name?: string }).name?.endsWith("Sync")) {
          const e = deny(`fs open of ${String(args[0])}`);
          process.nextTick(() => (cb as (...a: unknown[]) => void)(e));
          return;
        }
        throw deny(`fs open of ${String(args[0])}`);
      }
      return (orig as (...a: unknown[]) => unknown).apply(this, args);
    };
  };

  for (const name of reads) {
    for (const n of [name, name + "Sync"]) {
      if (typeof mod[n] === "function") mod[n] = wrap("read", n)(mod[n]);
    }
  }
  for (const name of writes) {
    for (const n of [name, name + "Sync"]) {
      if (typeof mod[n] === "function") mod[n] = wrap("write", n)(mod[n]);
    }
  }
  if (typeof mod.open === "function") mod.open = wrapOpen(mod.open);
  if (typeof mod.openSync === "function") {
    const orig = mod.openSync as (...a: unknown[]) => unknown;
    mod.openSync = function (...args: unknown[]) {
      const flags = typeof args[1] === "string" ? args[1] : "r";
      if (!pathAllowed(args[0], OPEN_WRITE_FLAGS.test(flags))) {
        throw deny(`fs openSync of ${String(args[0])}`);
      }
      return orig.apply(this, args);
    };
  }
  if (typeof mod.existsSync === "function") {
    const orig = mod.existsSync as (p: unknown) => boolean;
    mod.existsSync = (p: unknown) => (pathAllowed(p, false) ? orig(p) : false);
  }
  if (typeof mod.exists === "function") {
    const orig = mod.exists as (...a: unknown[]) => unknown;
    mod.exists = function (...args: unknown[]) {
      const cb = args[args.length - 1];
      if (!pathAllowed(args[0], false)) {
        if (typeof cb === "function") process.nextTick(() => (cb as (a: unknown) => void)(false));
        return;
      }
      return orig.apply(this, args);
    };
  }
  if (typeof mod.access === "function") mod.access = wrap("read", "access")(mod.access);
  if (typeof mod.accessSync === "function") mod.accessSync = wrap("read", "accessSync")(mod.accessSync);

  // two-path ops: rename / copyFile / cp / link / symlink
  const twoPath = (srcKind: "read" | "write", dstName: 1 | 2) => {
    return (orig: unknown): unknown => {
      if (typeof orig !== "function") return orig;
      return function (this: unknown, ...args: unknown[]) {
        const src = args[0];
        const dst = args[dstName === 1 ? 1 : 2];
        const cb = args[args.length - 1];
        const ok = pathAllowed(src, srcKind === "write") && pathAllowed(dst, true);
        if (!ok) {
          const e = deny(`fs operation on ${String(src)} -> ${String(dst)}`);
          if (typeof cb === "function") {
            process.nextTick(() => (cb as (a: unknown) => void)(e));
            return;
          }
          throw e;
        }
        return (orig as (...a: unknown[]) => unknown).apply(this, args);
      };
    };
  };
  for (const n of ["rename", "renameSync"]) {
    if (typeof mod[n] === "function") mod[n] = twoPath("write", 1)(mod[n]);
  }
  for (const n of ["copyFile", "copyFileSync", "cp", "cpSync"]) {
    if (typeof mod[n] === "function") mod[n] = twoPath("read", 1)(mod[n]);
  }
  for (const n of ["link", "linkSync"]) {
    if (typeof mod[n] === "function") mod[n] = twoPath("read", 1)(mod[n]);
  }
  for (const n of ["symlink", "symlinkSync"]) {
    if (typeof mod[n] === "function") {
      const orig = mod[n] as (...a: unknown[]) => unknown;
      mod[n] = function (...args: unknown[]) {
        // symlink(target, path) — the created link is arg1
        if (!pathAllowed(args[1], true)) throw deny(`fs symlink at ${String(args[1])}`);
        return orig.apply(this, args);
      };
    }
  }

  const promises = mod.promises as Record<string, unknown> | undefined;
  if (promises && typeof promises === "object") {
    patchFsModule(promises);
  }
}

patchFsModule(fs as unknown as Record<string, unknown>);
try {
  // node:fs/promises resolves to the same object as fs.promises — patch both to be safe.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsp = require("node:fs/promises") as Record<string, unknown>;
  patchFsModule(fsp);
} catch {
  /* older node */
}

/* ---------------------------------- net ---------------------------------- */

function hostAllowed(host: string): boolean {
  if (policy.netDomains === null) return true;
  const h = host.toLowerCase();
  return policy.netDomains.some((d) => h === d || h.endsWith("." + d));
}

function requestHost(opts: unknown): string {
  if (typeof opts === "string") return new URL(opts).hostname;
  if (opts instanceof URL) return opts.hostname;
  if (opts && typeof opts === "object") {
    const o = opts as Record<string, unknown>;
    const h = (o.hostname ?? o.host ?? "") as string;
    if (h) return h.split(":")[0];
  }
  return "";
}

function isLocalRuntime(host: string, port?: unknown): boolean {
  const p = typeof port === "string" ? Number(port) : (port as number | undefined);
  return (
    (host === "127.0.0.1" || host === "localhost" || host === "::1") &&
    typeof p === "number" &&
    policy.localPorts.includes(p)
  );
}

function patchRequest(mod: Record<string, unknown>, name: "request" | "get"): void {
  const orig = mod[name];
  if (typeof orig !== "function") return;
  mod[name] = function (this: unknown, ...args: unknown[]) {
    const opts = args[0];
    const o = opts && typeof opts === "object" && !(opts instanceof URL) ? (opts as Record<string, unknown>) : {};
    const host = requestHost(opts);
    const port = o.port;
    if (!hostAllowed(host) && !isLocalRuntime(host, port)) {
      throw deny(`outbound request to ${host}`);
    }
    return (orig as (...a: unknown[]) => unknown).apply(this, args);
  };
}

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const http = require("node:http") as Record<string, unknown>;
  patchRequest(http, "request");
  patchRequest(http, "get");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const https = require("node:https") as Record<string, unknown>;
  patchRequest(https, "request");
  patchRequest(https, "get");
} catch {
  /* ignore */
}

// global fetch (undici)
if (typeof globalThis.fetch === "function") {
  const origFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: unknown, init?: unknown) => {
    let host = "";
    let port: number | undefined;
    try {
      const u =
        typeof input === "string"
          ? new URL(input)
          : input instanceof URL
            ? input
            : new URL((input as Request).url);
      host = u.hostname;
      port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    } catch {
      return Promise.reject(deny("unparseable URL"));
    }
    if (!hostAllowed(host) && !isLocalRuntime(host, port)) {
      return Promise.reject(deny(`fetch to ${host}`));
    }
    return origFetch(input as never, init as never);
  }) as typeof fetch;
}

// net / tls connect — patch to stop raw sockets; broker+proxy ports stay allowed.
for (const modName of ["node:net", "node:tls"] as const) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(modName) as Record<string, unknown>;
    for (const fn of ["connect", "createConnection"]) {
      const orig = mod[fn];
      if (typeof orig !== "function") continue;
      mod[fn] = function (this: unknown, ...args: unknown[]) {
        let host = "";
        let port: number | undefined;
        const a0 = args[0];
        if (typeof a0 === "object" && a0 !== null) {
          host = String((a0 as Record<string, unknown>).host ?? (a0 as Record<string, unknown>).hostname ?? "");
          port = Number((a0 as Record<string, unknown>).port);
        } else if (typeof a0 === "number") {
          port = a0;
          host = String(args[1] ?? "");
        }
        if (!hostAllowed(host) && !isLocalRuntime(host, port)) {
          throw deny(`socket connect to ${host}:${port}`);
        }
        return (orig as (...a: unknown[]) => unknown).apply(this, args);
      };
    }
  } catch {
    /* ignore */
  }
}

// dns — refuse name resolution for non-declared domains
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dns = require("node:dns") as Record<string, unknown>;
  for (const fn of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"]) {
    const orig = dns[fn];
    if (typeof orig !== "function") continue;
    dns[fn] = function (this: unknown, ...args: unknown[]) {
      const host = String(args[0] ?? "");
      if (!hostAllowed(host) && host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
        const cb = args[args.length - 1];
        const e = deny(`dns ${fn} for ${host}`);
        if (typeof cb === "function") {
          process.nextTick(() => (cb as (a: unknown) => void)(e));
          return;
        }
        throw e;
      }
      return (orig as (...a: unknown[]) => unknown).apply(this, args);
    };
  }
  const promises = (dns.promises ?? undefined) as Record<string, unknown> | undefined;
  if (promises) {
    for (const fn of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"]) {
      const orig = promises[fn];
      if (typeof orig !== "function") continue;
      promises[fn] = function (this: unknown, ...args: unknown[]) {
        const host = String(args[0] ?? "");
        if (!hostAllowed(host) && host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
          return Promise.reject(deny(`dns ${fn} for ${host}`));
        }
        return (orig as (...a: unknown[]) => unknown).apply(this, args);
      };
    }
  }
} catch {
  /* ignore */
}

/* --------------------------------- shell --------------------------------- */

if (!policy.shellExec) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cp = require("node:child_process") as Record<string, unknown>;
    for (const fn of ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"]) {
      if (typeof cp[fn] === "function") {
        cp[fn] = () => {
          throw deny(`child_process.${fn} (needs the dangerous shell:exec scope)`);
        };
      }
    }
  } catch {
    /* ignore */
  }
}

export {};
