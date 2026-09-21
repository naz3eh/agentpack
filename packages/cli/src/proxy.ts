import http from "node:http";
import net from "node:net";
import { domainAllowed } from "@agentpack/schema";

/**
 * Built-in egress allowlist proxy. The CLI points the agent's HTTP_PROXY /
 * HTTPS_PROXY env vars here; the proxy refuses CONNECT tunnels and
 * absolute-form requests to non-declared domains.
 *
 * Honest limit: env vars only govern proxy-aware HTTP clients; Node's own
 * http/fetch ignore them — that's why the in-process preload patches exist
 * too. Neither layer is a kernel sandbox.
 */
export function startEgressProxy(allowlist: string[] | null): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = http.createServer((req, res) => {
    // absolute-form forward-proxy request: GET http://host/path
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (!domainAllowed(target.hostname, allowlist)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end(`agentpack: egress to ${target.hostname} denied by manifest policy`);
      return;
    }
    const upstream = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: target.pathname + target.search,
        method: req.method,
        headers: { ...req.headers, host: target.host },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", (e) => {
      res.writeHead(502).end(`agentpack proxy: ${e.message}`);
    });
    req.pipe(upstream);
  });

  server.on("connect", (req, clientSocket, head) => {
    const [host, portStr] = (req.url ?? "").split(":");
    const port = Number(portStr ?? 443);
    if (!domainAllowed(host, allowlist)) {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.destroy();
      return;
    }
    const upstream = net.connect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
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
