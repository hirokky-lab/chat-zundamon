import { request, type IncomingMessage, type ServerResponse } from "node:http";
import { responseCancellation } from "./response-cancellation.js";

export function proxyApi(req: IncomingMessage, res: ServerResponse, port: number): void {
  const proxy = request({ hostname: "127.0.0.1", port, path: req.url, method: req.method,
    headers: req.headers, signal: responseCancellation(req, res) }, upstream => {
    res.writeHead(upstream.statusCode ?? 502, upstream.headers);
    upstream.pipe(res);
  });
  proxy.on("error", () => {
    if (res.destroyed) return;
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(proxy);
}
