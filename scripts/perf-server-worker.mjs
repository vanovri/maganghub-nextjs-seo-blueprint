/**
 * High-throughput RFC 9112 HTTP/1.1 multi-core server replica worker (Phase 2.6).
 *
 * Mounts the ACTUAL `packages/nextjs-blueprint/app/sitemap.ts` (`createSitemapService`)
 * and ACTUAL `packages/nextjs-blueprint/middleware.ts` (`middlewareFast` via Node 24
 * `registerHooks`) directly on a low-allocation TCP HTTP/1.1 keep-alive server
 * (`node:net`, TCP_NODELAY) compatible with standard HTTP/1.1 clients (`k6`, `curl`,
 * `fetch`, `node:http`), eliminating JS IncomingMessage/ServerResponse stream overhead.
 */

import net from "node:net";
import { registerHooks } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") {
      return { shortCircuit: true, url: "virtual:replica-next-server-shim" };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "virtual:replica-next-server-shim") {
      return {
        shortCircuit: true,
        format: "module",
        source: `
          const NEXT_HEADERS = { "x-middleware-next": "1", "content-length": "0" };
          const EMPTY_BUF = Buffer.alloc(0);
          export class NextResponse {
            constructor(body = null, init = {}) {
              this.status = init.status ?? 200;
              this.rawHeaders = init.headers || {};
              this.bodyBuffer =
                body == null
                  ? EMPTY_BUF
                  : body instanceof Uint8Array
                    ? Buffer.from(body.buffer, body.byteOffset, body.byteLength)
                    : Buffer.from(String(body), "utf8");
            }
            static next() {
              return SINGLETON_NEXT;
            }
          }
          const SINGLETON_NEXT = new NextResponse(null, { status: 200, headers: NEXT_HEADERS });
          export class NextRequest {}
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const { role, urlCount, urlLimit, kvBaseUrl, nowMs } = workerData;

const STATUS_TEXT = {
  200: "OK",
  404: "Not Found",
  410: "Gone",
  500: "Internal Server Error",
};

function encodeHttp11Response(status, headers, bodyBuf) {
  const reason = STATUS_TEXT[status] || "OK";
  let head = `HTTP/1.1 ${status} ${reason}\r\nConnection: keep-alive\r\n`;
  let hasContentLength = false;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "content-length") hasContentLength = true;
    head += `${k}: ${v}\r\n`;
  }
  if (!hasContentLength) {
    head += `content-length: ${bodyBuf.length}\r\n`;
  }
  head += "\r\n";
  const headBuf = Buffer.from(head, "latin1");
  return bodyBuf.length > 0 ? Buffer.concat([headBuf, bodyBuf]) : headBuf;
}

const ERROR_500_WIRE = encodeHttp11Response(
  500,
  { "content-type": "text/plain; charset=utf-8" },
  Buffer.from("Internal Server Error", "utf8"),
);

function generateSyntheticVacancies(count) {
  const items = new Array(count);
  for (let i = 0; i < count; i += 1) {
    items[i] = {
      slug: `magang-nasional-batch3b-${i}`,
      status: "OPEN",
      validThrough: "2026-12-25T23:59:59+07:00",
      updatedAt: "2026-11-21T08:00:00+07:00",
    };
  }
  return items;
}

function readMemMB() {
  if (typeof globalThis.gc === "function") {
    globalThis.gc();
    globalThis.gc();
  }
  const m = process.memoryUsage();
  return {
    heapUsedMB: Math.round((m.heapUsed / (1024 * 1024)) * 100) / 100,
    rssMB: Math.round((m.rss / (1024 * 1024)) * 100) / 100,
  };
}

let handleHttpRequest;
let uncaughtUriErrors = 0;
let extraInfo = {};

if (role === "sitemap") {
  const { createSitemapService } = await import("../packages/nextjs-blueprint/app/sitemap.ts");
  const records = generateSyntheticVacancies(urlCount);
  const svc = createSitemapService({
    fetchVacancies: async () => records,
    urlLimit,
    nowFn: () => nowMs,
  });
  const snap = await svc.getSnapshot();
  extraInfo = { totalUrls: snap.totalUrls, shardCount: snap.shardCount };

  // Wire-frame cache keyed by `bodyBuffer` identity so zero per-request Buffer.concat occurs
  const wireFrameCache = new WeakMap();
  const toWire = (payload) => {
    let frame = wireFrameCache.get(payload.body);
    if (!frame) {
      frame = encodeHttp11Response(payload.status, payload.headers, payload.body);
      wireFrameCache.set(payload.body, frame);
    }
    return frame;
  };

  handleHttpRequest = (rawUrl, acceptEncoding, socket) => {
    const qIdx = rawUrl.indexOf("?");
    const pathname = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
    const maybePayload = svc.serveRequestFast(pathname, acceptEncoding);
    if (maybePayload && typeof maybePayload.then === "function") {
      maybePayload
        .then((payload) => {
          if (!socket.destroyed) socket.write(toWire(payload));
        })
        .catch(() => {
          if (!socket.destroyed) socket.write(ERROR_500_WIRE);
        });
    } else if (!socket.destroyed) {
      socket.write(toWire(maybePayload));
    }
  };
} else if (role === "middleware") {
  const { clearArchivedSlugCache, getArchivedSlugCacheStats, isPermanentlyArchived, middlewareFast } =
    await import("../packages/nextjs-blueprint/middleware.ts");
  clearArchivedSlugCache();

  const lookupNormal = { edgeUrl: kvBaseUrl, timeoutMs: 400, bypassCache: false, cacheTtlMs: 60_000 };
  await Promise.all([
    ...Array.from({ length: 20 }, (_, i) => isPermanentlyArchived(`archived-batch1-${i}`, lookupNormal)),
    ...Array.from({ length: 20 }, (_, i) => isPermanentlyArchived(`active-batch3b-${i}`, lookupNormal)),
  ]);

  const NEXT_200_WIRE = encodeHttp11Response(
    200,
    { "x-middleware-next": "1", "content-length": "0" },
    Buffer.alloc(0),
  );
  const wireByBody = new WeakMap();
  const toMwWire = (mwRes) => {
    if (mwRes.status === 200 && mwRes.bodyBuffer.length === 0 && mwRes.rawHeaders["x-middleware-next"] === "1") {
      return NEXT_200_WIRE;
    }
    let frame = wireByBody.get(mwRes.bodyBuffer);
    if (!frame) {
      frame = encodeHttp11Response(mwRes.status, mwRes.rawHeaders, mwRes.bodyBuffer);
      wireByBody.set(mwRes.bodyBuffer, frame);
    }
    return frame;
  };

  handleHttpRequest = (rawUrl, _acceptEncoding, socket) => {
    try {
      const qIdx = rawUrl.indexOf("?");
      const pathname = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
      const maybeRes = middlewareFast({ nextUrl: { pathname } }, lookupNormal);
      if (maybeRes && typeof maybeRes.then === "function") {
        maybeRes
          .then((mwRes) => {
            if (!socket.destroyed) socket.write(toMwWire(mwRes));
          })
          .catch((err) => {
            if (err instanceof URIError) uncaughtUriErrors += 1;
            if (!socket.destroyed) socket.write(ERROR_500_WIRE);
          });
      } else if (!socket.destroyed) {
        socket.write(toMwWire(maybeRes));
      }
    } catch (err) {
      if (err instanceof URIError) uncaughtUriErrors += 1;
      if (!socket.destroyed) socket.write(ERROR_500_WIRE);
    }
  };

  extraInfo = { getCacheStats: getArchivedSlugCacheStats };
}

const activeSockets = new Set();
const server = net.createServer({ noDelay: true }, (socket) => {
  socket.setNoDelay(true);
  activeSockets.add(socket);
  socket.on("close", () => activeSockets.delete(socket));
  socket.on("error", () => activeSockets.delete(socket));

  let carry = "";
  socket.on("data", (chunk) => {
    carry += chunk.toString("latin1");
    while (true) {
      const headerEnd = carry.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const head = carry.slice(0, headerEnd);
      carry = carry.slice(headerEnd + 4);

      const lineEnd = head.indexOf("\r\n");
      const reqLine = lineEnd === -1 ? head : head.slice(0, lineEnd);
      const sp1 = reqLine.indexOf(" ");
      const sp2 = reqLine.indexOf(" ", sp1 + 1);
      const rawUrl = sp1 !== -1 && sp2 !== -1 ? reqLine.slice(sp1 + 1, sp2) : "/";

      let acceptEncoding = "";
      const aeIdx = head.toLowerCase().indexOf("\r\naccept-encoding:");
      if (aeIdx !== -1) {
        const valStart = aeIdx + 18;
        const valEnd = head.indexOf("\r\n", valStart);
        acceptEncoding = (valEnd === -1 ? head.slice(valStart) : head.slice(valStart, valEnd)).trim();
      }

      handleHttpRequest(rawUrl, acceptEncoding, socket);
    }
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

parentPort.postMessage({
  type: "ready",
  port,
  memory: readMemMB(),
  ...(role === "sitemap" ? extraInfo : {}),
});

parentPort.on("message", (msg) => {
  if (msg?.cmd === "stats") {
    const cacheStats = role === "middleware" ? extraInfo.getCacheStats() : null;
    parentPort.postMessage({
      type: "stats",
      memory: readMemMB(),
      uncaughtUriErrors,
      cacheStats,
    });
  } else if (msg?.cmd === "shutdown") {
    for (const s of activeSockets) s.destroy();
    server.close(() => process.exit(0));
  }
});
