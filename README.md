# agentpack

**An MVP distribution + install layer for AI agents.** A package manifest, a tiny registry, a CLI, and a scoped runtime that never hands raw user credentials to agent code.

Anyone can vibe-code an agent in a weekend, but today distribution means "clone this repo, install poetry, paste your OpenAI key into a `.env`." agentpack is the missing packaging/permissions layer: install an agent like `agentpack run <name>` — with declared, enforceable scopes — and free, zero-infra publishing for authors.

## Quickstart

```bash
npm install && npm run build
npm test

# terminal 1 — local registry
node packages/registry/dist/bin.js --port 4873 --data ./.agentpack-data

# terminal 2
export AGENTPACK_REGISTRY=http://127.0.0.1:4873
node packages/cli/dist/bin.js publisher create me          # mints + saves a token
node packages/cli/dist/bin.js publish examples/summarize-url --publisher me
node packages/cli/dist/bin.js install summarize-url        # Jev review gate runs first
PAGE_URL=https://example.com \
  node packages/cli/dist/bin.js run summarize-url          # brokered LLM (mock mode without a key)

node packages/cli/dist/bin.js find "summarize a web page"  # Jev picks from the catalog
node packages/cli/dist/bin.js review summarize-url         # permission sanity check
node packages/cli/dist/bin.js init ./my-agent --describe "watches my downloads and files receipts"
```

Or install the CLI globally: `npm install -g ./packages/cli` → `agentpack ...`.

## The manifest — `agentpack.json`

```json
{
  "name": "summarize-url",
  "version": "0.1.0",
  "description": "Summarizes a web page",
  "entrypoint": "dist/index.js",
  "runtime": "node20",
  "scopes": [
    "net:example.com",
    "fs:read:/downloads",
    "env:SUMMARY_LANG",
    "llm:call"
  ],
  "models": { "preferred": ["gpt-4o-mini", "claude-haiku-4-5"] }
}
```

**Closed scope vocabulary** — anything else fails validation:

| scope | meaning |
|---|---|
| `net:<domain>` | outbound requests limited to `<domain>` (+ subdomains); `net:*` = any |
| `fs:read:<abs path>` | read-only access under a path prefix (`~`/`$HOME` expand at run time) |
| `fs:write:<abs path>` | read+write under a path prefix |
| `env:<NAME>` | may read only the listed env var |
| `llm:call` | may call the brokered LLM endpoint (`AGENTPACK_LLM_URL`) |
| `shell:exec` | may spawn arbitrary processes — **dangerous**, hard warning at install |

## Commands

- `init <dir> [--describe "..."]` — scaffold an agent; `--describe` asks **Jev** to pick scopes from the closed vocabulary.
- `publisher create <name>` — mint a bearer token (`POST /publishers`), saved to `~/.agentpack/config.json`.
- `publish <dir> [--publisher name | --token T]` — validate manifest, tarball, upload.
- `install <name>[@ver] [-y]` — fetch, verify sha256, unpack to `~/.agentpack/agents/<name>/<ver>`.
- `run <name>[@ver] [-- args]` — execute under the declared policy.
- `find "<query>"` — Jev picks the best catalog entry (always a real entry, or `none`).
- `review <name|dir>` — Jev permission sanity check; runs automatically pre-install.
- `registry [--port N] [--data DIR]` — run a local registry.
- `list` — installed agents.

## How the runtime enforces scopes

`agentpack run` spawns the entrypoint as a child Node process:

- **env** — `process.env` is filtered to declared `env:` vars plus a minimal passthrough set (PATH, HOME, runtime wiring). Undeclared secrets simply don't exist inside the agent.
- **fs** — a `--require` preload wraps `fs`/`fs.promises` so reads/writes outside declared prefixes throw `EPERM` (the agent's own install dir stays readable).
- **net** — two layers: `HTTP_PROXY`/`HTTPS_PROXY` point at a built-in allowlist proxy (CONNECT + absolute-form) *and* the preload patches `http`/`https`/`fetch`/`net`/`tls`/`dns` to refuse non-declared hosts.
- **shell** — `child_process` is denied outright unless `shell:exec` is declared.
- **llm:call** — the CLI serves a local broker at `AGENTPACK_LLM_URL`. The agent POSTs OpenAI-style `/chat/completions`; the broker injects the **user's** provider key (`AGENTPACK_LLM_API_KEY` or `config.llm.apiKey`), forwards to `AGENTPACK_LLM_UPSTREAM`, and enforces `models.preferred` + per-run call/token caps. **The key never enters the agent process.** With no upstream configured the broker returns a deterministic mock so agents still run.

## Security model — what this does and does NOT stop

Honest version: this is **runtime patching inside a normal Node process plus an env-based proxy — not a kernel sandbox.** It reliably stops the common cases: undeclared env vars, filesystem access outside declared prefixes, plain HTTP/HTTPS/fetch/socket calls to undeclared domains, and subprocesses. It does **not** stop a determined adversarial agent: native addons, `ffi`, ABIs, side channels, or worker tricks can bypass module patching, and `HTTP_PROXY` only governs proxy-aware clients (hence the preload). For untrusted agents you still want real isolation (seccomp, containers, VMs). agentpack's bet: **declared scopes + fail-loud enforcement + a pre-install Jev review catches the 95% case** — accidents, laziness, and overreach — for free.

The registry is a dumb store: it authenticates publishers and serves content-addressed tarballs (sha256 verified at install). Compromise of the registry can serve you a *different* agent, but can't exceed the manifest you saw and approved — the boundary is the manifest+runtime, not the registry.

## Where Jev (TypeSafe AI) does the decision-making

All three integrations run through an injectable `JevClient` (`@agentpack/jev`); when `TYPESAFE_API_KEY` is unset — or the API errors — each falls back to deterministic keyword heuristics. Tests mock the client; no key is needed.

1. **`review` / pre-install gate** — manifest description + scopes + entrypoint snippet → closed choice `{reasonable, over_permissioned, suspicious}` + a flag the CLI renders as a short reason ("requests fs:write:/ for a text summarizer"). Non-reasonable verdicts prompt before install.
2. **`find`** — user query + catalog → closed choice over real catalog entries + `none`. Jev selects, never invents.
3. **`init --describe`** — NL description → closed per-capability choices over the scope vocabulary → draft manifest you edit.

## Roadmap

- Hosted registry (packages.dev-style) with signed manifests + publisher identity
- Sandboxed backend (container/seccomp) to replace env-proxy + preload patching
- `agentpack.yaml` lockfiles, semver ranges, transitive agent deps
- richer Jev review (diffs between versions, reputation signals)

## Layout

```
packages/schema    manifest spec + zod validator + policy compiler
packages/registry  REST registry: bearer-auth publish, anonymous read, SQLite + blob store
packages/jev       injectable TypeSafe client + fallback plumbing
packages/cli       the agentpack binary (init/publish/install/run/find/review)
examples/summarize-url  a real agent: net:* + llm:call
```

MIT. No secrets, no infra required.
