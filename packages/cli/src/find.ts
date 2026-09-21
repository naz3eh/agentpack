import { jevOr, type JevClient } from "@agentpack/jev";

export interface CatalogEntry {
  name: string;
  description: string;
  latest?: string;
}

const STOP = new Set(["a", "an", "the", "my", "me", "to", "of", "and", "for", "in", "on", "that", "this", "it", "i"]);

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !STOP.has(t));
}

/** Deterministic keyword-overlap fallback. */
export function fallbackFind(query: string, catalog: CatalogEntry[]): string | null {
  const q = tokens(query);
  let best: { name: string; score: number } | null = null;
  for (const e of catalog) {
    const hay = new Set([...tokens(e.name), ...tokens(e.description)]);
    const score = q.filter((t) => hay.has(t)).length;
    if (score > 0 && (!best || score > best.score)) best = { name: e.name, score };
  }
  return best?.name ?? null;
}

/**
 * Jev picks the best catalog match for a natural-language query.
 * Closed set: the answer is always a real catalog entry or "none".
 */
export async function findAgent(
  query: string,
  catalog: CatalogEntry[],
  client: JevClient | null,
): Promise<{ name: string | null; source: "jev" | "fallback" }> {
  if (catalog.length === 0) return { name: null, source: "fallback" };
  const criteria: Record<string, string> = {};
  for (const e of catalog.slice(0, 25)) {
    criteria[e.name] = `${e.description}${e.latest ? ` (v${e.latest})` : ""}`;
  }
  criteria.none = "No catalog entry is a good match for the request.";

  const { value, source } = await jevOr(
    client,
    async (c) => {
      const r = await c.choose(
        { request: query, catalog: catalog.map((e) => ({ name: e.name, description: e.description })) },
        "pick",
        "Which catalog entry best matches the user's request? Pick a real entry, or 'none' if nothing fits.",
        criteria,
      );
      return r.choice;
    },
    () => fallbackFind(query, catalog),
  );

  const name = value === "none" || !catalog.some((e) => e.name === value) ? null : value;
  return { name, source };
}
