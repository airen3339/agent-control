#!/usr/bin/env node
import http from "node:http";

function parseTargetUrl(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--url" && argv[i + 1]) {
      return argv[i + 1];
    }
    if (argv[i].startsWith("--url=")) {
      return argv[i].slice("--url=".length);
    }
  }
  return "";
}

if (process.env.MOCK_CLOUDFLARED_FAIL === "1") {
  process.stderr.write("ERR failed to initialize mock quick tunnel edge connection\n");
  process.exit(1);
}

const targetRaw = parseTargetUrl(process.argv.slice(2));
if (!targetRaw) {
  process.stderr.write("ERR missing --url argument\n");
  process.exit(2);
}

const targetBase = new URL(targetRaw);

const server = http.createServer((clientReq, clientRes) => {
  const upstreamUrl = new URL(clientReq.url || "/", targetBase);
  const headers = {
    ...clientReq.headers,
    host: "demo-quick-tunnel.trycloudflare.com",
    "cf-connecting-ip": "203.0.113.42",
    "cf-ray": "89abcdef01234567-HKG",
    "cf-visitor": "{\"scheme\":\"http\"}",
    "x-forwarded-for": "203.0.113.42",
    "x-forwarded-proto": "http",
  };

  const upstreamReq = http.request(upstreamUrl, {
    method: clientReq.method || "GET",
    headers,
  }, (upstreamRes) => {
    clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(clientRes);
  });

  upstreamReq.on("error", (err) => {
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    }
    if (!clientRes.writableEnded) {
      clientRes.end(JSON.stringify({ error: { message: err?.message || "proxy upstream error" } }));
    }
  });

  clientReq.on("aborted", () => {
    upstreamReq.destroy();
  });

  clientReq.pipe(upstreamReq);
});

server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  const proxyPort = typeof addr === "object" && addr ? addr.port : 0;
  process.stderr.write("2026-11-14T21:40:00Z INF Checking cloudflared API at https://api.trycloudflare.com\n");
  process.stderr.write(`2026-11-14T21:40:00Z INF AGENT_CONTROL_TUNNEL_URL=http://127.0.0.1:${proxyPort}\n`);
});

function shutdown() {
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 250).unref?.();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
