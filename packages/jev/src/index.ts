import { TypeSafeClient, choice } from "@typesafe-ai/sdk";

export { choice };

export type ChoiceCriteria = Record<string, string>;

/** Minimal interface every Jev integration is written against — easy to mock in tests. */
export interface JevClient {
  choose(
    state: unknown,
    question: string,
    instructions: string,
    criteria: ChoiceCriteria,
  ): Promise<{ choice: string; confidence: number }>;
}

/** Real client backed by @typesafe-ai/sdk's systemOne. */
export function createJevClient(apiKey?: string): JevClient {
  const client = new TypeSafeClient({ apiKey });
  return {
    async choose(state, _question, instructions, criteria) {
      const res = await client.systemOne({
        state: state as never,
        questions: { q: choice(instructions, criteria) },
      });
      return {
        choice: res.answers.q.choice as string,
        confidence: res.answers.q.confidence,
      };
    },
  };
}

/**
 * Returns a real Jev client when TYPESAFE_API_KEY is set, otherwise null —
 * callers then run their deterministic fallback path.
 */
export function getJevClient(env: NodeJS.ProcessEnv = process.env): JevClient | null {
  const key = env.TYPESAFE_API_KEY;
  if (!key || !key.trim()) return null;
  try {
    return createJevClient(key);
  } catch {
    return null;
  }
}

/**
 * Run `fn` through Jev when a client is available, else `fallback()`.
 * Jev errors also degrade to the fallback (network blips shouldn't break the CLI).
 */
export async function jevOr<T>(
  client: JevClient | null,
  fn: (c: JevClient) => Promise<T>,
  fallback: () => T | Promise<T>,
): Promise<{ value: T; source: "jev" | "fallback" }> {
  if (client) {
    try {
      return { value: await fn(client), source: "jev" };
    } catch {
      // fall through to deterministic fallback
    }
  }
  return { value: await fallback(), source: "fallback" };
}
