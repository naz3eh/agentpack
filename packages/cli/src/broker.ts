import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";

export interface BrokerOptions {
  /** Models the manifest declared under models.preferred ([] = any model). */
  allowedModels: string[];
  /** Where to forward: e.g. https://api.openai.com/v1 (or a test endpoint). */
  upstream?: string;
  /** The USER's provider key — injected here, never exposed to the agent. */
  apiKey?: string;
  maxCalls?: number;
  maxTokens?: number;
  onLog?: (msg: string) => void;
}

const DEFAULT_MAX_CALLS = 20;
const DEFAULT_MAX_TOKENS = 250_000;

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > 8 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function upstreamChatUrl(upstream: string): string {
  const u = upstream.replace(/\/+$/, "");
  if (u.endsWith("/chat/completions")) return u;
  return `${u}/chat/completions`;
}

/** Deterministic offline response so `llm:call` agents run without a provider configured. */
function mockCompletion(model: string, messages: unknown): object {
  const last = Array.isArray(messages) && messages.length
    ? String((messages[messages.length - 1] as { content?: unknown })?.content ?? "")
    : "";
  return {
    id: `chatcmpl-mock-${crypto.randomBytes(4).toString("hex")}`,
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: `[agentpack mock LLM] no upstream configured — received ${last.length} chars`,
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/**
 * The brokered LLM endpoint exposed to agents as AGENTPACK_LLM_URL.
 * Forwards OpenAI-style chat completions to the user's configured upstream,
 * injecting the user's key at this layer and enforcing the manifest's
 * models.preferred allowlist + per-run call/token caps.
 */
export function startLlmBroker(opts: BrokerOptions): Promise<{ port: number; close: () => Promise<void> }> {
  const maxCalls = opts.maxCalls ?? DEFAULT_MAX_CALLS;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  let calls = 0;
  let tokens = 0;

  const server = http.createServer((req, res) => {
    (async () => {
      if (req.method !== "POST" || !(req.url ?? "").endsWith("/chat/completions")) {
        if (req.method === "GET" && (req.url ?? "") === "/health") {
          return json(res, 200, { ok: true });
        }
        return json(res, 404, { error: "agentpack broker: POST /chat/completions only" });
      }

      calls += 1;
      if (calls > maxCalls) {
        return json(res, 429, { error: `agentpack: LLM call cap reached (${maxCalls} per run)` });
      }
      if (tokens >= maxTokens) {
        return json(res, 429, { error: `agentpack: LLM token cap reached (${maxTokens} per run)` });
      }

      const body = JSON.parse((await readBody(req)).toString("utf8")) as {
        model?: string;
        messages?: unknown;
      };
      const model = body.model ?? "default";
      if (opts.allowedModels.length && !opts.allowedModels.includes(model)) {
        return json(res, 403, {
          error: `agentpack: model "${model}" not in manifest models.preferred (${opts.allowedModels.join(", ")})`,
        });
      }

      if (!opts.upstream) {
        opts.onLog?.(`llm call ${calls}: model=${model} (no upstream configured — mock response)`);
        return json(res, 200, mockCompletion(model, body.messages));
      }

      const upstream = await fetch(upstreamChatUrl(opts.upstream), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // the user's key is injected HERE — the agent process never sees it
          ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
        },
        body: JSON.stringify({ ...body, model }),
      });
      const text = await upstream.text();
      try {
        const parsed = JSON.parse(text);
        const used = parsed?.usage?.total_tokens;
        if (typeof used === "number") tokens += used;
      } catch {
        /* non-JSON upstream response passes through */
      }
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      res.end(text);
    })().catch((e) => json(res, 500, { error: `agentpack broker: ${e.message}` }));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
