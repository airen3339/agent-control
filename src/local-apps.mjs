import { readdir, readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import {
  acceptsGzip,
  GZIP_MIN_BYTES,
  isCompressibleContentType,
  mergeVaryHeader,
} from "./http-response.mjs";
import { resolvePlatformAppsDir } from "./platform.mjs";

export const LOCAL_APPS_DIR = resolvePlatformAppsDir();

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function sanitizeProxyHeaders(headers, { response = false } = {}) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => {
    const lower = name.toLowerCase();
    if (lower === "x-ac-bridge-token") return false;
    return !HOP_BY_HOP_HEADERS.has(lower) && (!response || lower !== "set-cookie");
  }));
}

function validApp(value) {
  if (!value || !/^[a-z0-9-]+$/.test(value.id || "") || !value.name || !value.origin) return null;
  const origin = new URL(value.origin);
  if (origin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(origin.hostname)) return null;
  return {
    id: value.id,
    name: String(value.name),
    description: String(value.description || ""),
    capabilities: Array.isArray(value.capabilities) ? value.capabilities.map(String).slice(0, 6) : [],
    enabledInstanceIds: Array.isArray(value.enabledInstanceIds)
      ? [...new Set(value.enabledInstanceIds.map(String).map((item) => item.trim()).filter(Boolean))].slice(0, 32)
      : [],
    disabledInstanceIds: Array.isArray(value.disabledInstanceIds)
      ? [...new Set(value.disabledInstanceIds.map(String).map((item) => item.trim()).filter(Boolean))].slice(0, 32)
      : [],
    enabledAccountEmails: Array.isArray(value.enabledAccountEmails)
      ? [...new Set(value.enabledAccountEmails.map(String).map((item) => item.trim().toLowerCase()).filter(Boolean))].slice(0, 32)
      : [],
    disabledAccountEmails: Array.isArray(value.disabledAccountEmails)
      ? [...new Set(value.disabledAccountEmails.map(String).map((item) => item.trim().toLowerCase()).filter(Boolean))].slice(0, 32)
      : [],
    origin: origin.origin,
    href: `/apps/${value.id}/`,
  };
}

function appEnabledForContext(app, { instanceId = "", accountEmail = "" } = {}) {
  const normalizedEmail = accountEmail.trim().toLowerCase();
  if (instanceId && app.disabledInstanceIds.includes(instanceId)) return false;
  if (app.enabledInstanceIds.length && !app.enabledInstanceIds.includes(instanceId)) return false;
  if (normalizedEmail && app.disabledAccountEmails.includes(normalizedEmail)) return false;
  return !app.enabledAccountEmails.length || app.enabledAccountEmails.includes(normalizedEmail);
}

export async function listLocalApps(directory = LOCAL_APPS_DIR, context = {}) {
  const names = await readdir(directory).catch(() => []);
  const apps = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
    try {
      return validApp(JSON.parse(await readFile(resolve(directory, name), "utf8")));
    } catch {
      return null;
    }
  }));
  return apps.filter(Boolean).filter((app) => appEnabledForContext(app, context)).sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

export async function proxyLocalApp(request, response, url, directory = LOCAL_APPS_DIR, context = {}) {
  const match = url.pathname.match(/^\/apps\/([a-z0-9-]+)(\/.*)?$/);
  if (!match) return false;
  const app = (await listLocalApps(directory, context)).find((item) => item.id === match[1]);
  if (!app) {
    response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: { message: "本机扩展未安装" } }));
    return true;
  }
  if (!match[2]) {
    response.writeHead(302, { Location: `./${encodeURIComponent(match[1])}/${url.search}` });
    response.end();
    return true;
  }
  const upstreamUrl = new URL(`${match[2]}${url.search}`, app.origin);
  const clientAcceptsGzip = acceptsGzip(request.headers["accept-encoding"]);
  const headers = {
    ...sanitizeProxyHeaders(request.headers),
    host: upstreamUrl.host,
    "x-ac-proxied-app": app.id,
  };
  delete headers.cookie;
  headers["accept-encoding"] = "identity";
  const abortController = new AbortController();
  const abortUpstream = () => abortController.abort();
  request.once("aborted", abortUpstream);
  response.once("close", abortUpstream);
  try {
    const chunks = [];
    if (request.method !== "GET" && request.method !== "HEAD") {
      for await (const chunk of request) chunks.push(chunk);
    }
    const upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
      redirect: "manual",
      signal: abortController.signal,
    });
    const responseHeaders = sanitizeProxyHeaders(Object.fromEntries(upstreamResponse.headers), { response: true });
    delete responseHeaders["content-encoding"];
    if (String(upstreamResponse.headers.get("content-type") || "").startsWith("text/event-stream")) {
      response.writeHead(upstreamResponse.status, responseHeaders);
      if (upstreamResponse.body) {
        try {
          await pipeline(Readable.fromWeb(upstreamResponse.body), response, { signal: abortController.signal });
        } catch (error) {
          if (!abortController.signal.aborted) throw error;
        }
      } else {
        response.end();
      }
      return true;
    }
    const status = upstreamResponse.status;
    const isHead = String(request.method || "GET").toUpperCase() === "HEAD";
    if (status === 204 || status === 304) {
      delete responseHeaders["content-length"];
      responseHeaders["vary"] = mergeVaryHeader(responseHeaders["vary"]);
      response.writeHead(status, responseHeaders);
      response.end();
      return true;
    }
    const contentType = responseHeaders["content-type"];
    if (!isHead && upstreamResponse.body && (status === 206 || !isCompressibleContentType(contentType))) {
      responseHeaders["vary"] = mergeVaryHeader(responseHeaders["vary"]);
      response.writeHead(status, responseHeaders);
      try {
        await pipeline(Readable.fromWeb(upstreamResponse.body), response, { signal: abortController.signal });
      } catch (error) {
        if (!abortController.signal.aborted) throw error;
      }
      return true;
    }
    const content = Buffer.from(await upstreamResponse.arrayBuffer());
    const useGzip = !isHead
      && clientAcceptsGzip
      && content.length >= GZIP_MIN_BYTES
      && isCompressibleContentType(contentType);
    const body = useGzip ? gzipSync(content, { level: 6 }) : content;
    responseHeaders["vary"] = mergeVaryHeader(responseHeaders["vary"]);
    if (useGzip) {
      responseHeaders["content-encoding"] = "gzip";
    }
    responseHeaders["content-length"] = String(body.length);
    response.writeHead(status, responseHeaders);
    response.end(isHead ? undefined : body);
  } catch {
    if (response.headersSent || response.destroyed) return true;
    response.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: { message: `${app.name} 暂未启动` } }));
  } finally {
    request.off("aborted", abortUpstream);
    response.off("close", abortUpstream);
  }
  return true;
}
