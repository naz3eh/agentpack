export class HttpError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`);
  }
}

export async function apiJson(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, text);
  return text ? JSON.parse(text) : null;
}

export async function apiDownload(url: string): Promise<{ buf: Buffer; sha256?: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new HttpError(res.status, await res.text());
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, sha256: res.headers.get("x-agentpack-sha256") ?? undefined };
}
