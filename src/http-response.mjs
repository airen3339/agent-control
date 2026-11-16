import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

export const GZIP_MIN_BYTES = 1024;

export function matchesIfNoneMatch(headerValue, etag) {
  if (!headerValue || !etag) return false;
  const raw = String(headerValue).trim();
  if (!raw) return false;
  if (raw === "*") return true;
  const stripWeak = (v) => v.trim().replace(/^W\//i, "");
  const target = stripWeak(etag);
  return raw.split(",").some((token) => stripWeak(token) === target);
}

export function acceptsGzip(headerValue) {
  const raw = String(headerValue || "").toLowerCase();
  if (!raw) return false;
  for (const part of raw.split(",")) {
    const segments = part.trim().split(";").map((s) => s.trim()).filter(Boolean);
    if (segments[0] !== "gzip") continue;
    const qSeg = segments.find((s) => s.startsWith("q="));
    if (qSeg) {
      const qVal = Number(qSeg.slice(2));
      if (Number.isFinite(qVal) && qVal <= 0) return false;
    }
    return true;
  }
  return false;
}

export function isCompressibleContentType(contentType) {
  const mime = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (!mime || mime === "text/event-stream") return false;
  return (
    mime === "application/json"
    || mime === "text/html"
    || mime === "application/javascript"
    || mime === "text/javascript"
    || mime === "text/css"
    || mime === "image/svg+xml"
    || mime === "text/plain"
    || mime === "application/xml"
    || mime === "text/xml"
  );
}

export function mergeVaryHeader(existing, token = "Accept-Encoding") {
  const parts = String(existing || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const lowerToken = String(token).toLowerCase();
  if (!parts.some((p) => p.toLowerCase() === lowerToken)) {
    parts.push(token);
  }
  return parts.join(", ");
}

export function sendJson(response, status, payload, { requestId, request = null } = {}) {
  if (response.headersSent || response.writableEnded || response.destroyed) return false;
  const req = request || response?.req || null;
  if (status === 204 || status === 304) {
    response.writeHead(status, {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      Vary: "Accept-Encoding",
      ...(requestId ? { "X-Request-Id": requestId } : {}),
    });
    response.end();
    return true;
  }
  const raw = Buffer.from(JSON.stringify(payload), "utf8");
  const method = String(req?.method || "GET").toUpperCase();
  const isGetOrHead = method === "GET" || method === "HEAD";
  const etag = (status === 200 && isGetOrHead)
    ? `W/"${raw.length}-${createHash("sha1").update(raw).digest("base64url").slice(0, 16)}"`
    : "";
  if (etag && matchesIfNoneMatch(req?.headers?.["if-none-match"], etag)) {
    response.writeHead(304, {
      "Cache-Control": "no-store",
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
      Vary: "Accept-Encoding",
      ...(requestId ? { "X-Request-Id": requestId } : {}),
    });
    response.end();
    return true;
  }
  const useGzip = raw.length >= GZIP_MIN_BYTES && acceptsGzip(req?.headers?.["accept-encoding"]);
  const body = useGzip ? gzipSync(raw, { level: 6 }) : raw;
  const isHead = method === "HEAD";
  response.writeHead(status, {
    "Cache-Control": "no-store",
    ...(etag ? { ETag: etag } : {}),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    "X-Content-Type-Options": "nosniff",
    Vary: "Accept-Encoding",
    ...(useGzip ? { "Content-Encoding": "gzip" } : {}),
    ...(requestId ? { "X-Request-Id": requestId } : {}),
  });
  response.end(isHead ? undefined : body);
  return true;
}
