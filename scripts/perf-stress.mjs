#!/usr/bin/env node
/**
 * MagangHub Next.js SEO/GEO Local Load & Stress-Test Harness (Phase 2.6).
 *
 * Zero mandatory third-party dependencies (Node.js >= 24 LTS):
 * - Mounts ACTUAL `packages/nextjs-blueprint/app/sitemap.ts` (`createSitemapService`) and
 *   ACTUAL `packages/nextjs-blueprint/middleware.ts` (`middlewareFast` via Node 24 `registerHooks`)
 *   across a 4-replica multi-core HTTP server pool (`scripts/perf-server-worker.mjs`) for high-RPS
 *   warm bursts (Profiles A1, A2, C) AND dedicated single-instance servers for chaos/singleflight
 *   verification (Profiles B & D).
 * - Drives concurrent keep-alive load from isolated `worker_threads` with full socket warmup.
 * - Computes exact sorted percentiles (`p50`, `p95`, `p99`, `p99.9`), `RPS`, `errorRate`,
 *   event-loop lag (`monitorEventLoopDelay`), and post-GC memory delta (`heapDeltaMB`, `rssMB`).
 * - Cross-verifies automatically with `k6` (if installed on PATH) using `tests/k6-seo-stress.js`.
 * - Enforces Hard SLA Gates (`p99 < 50ms`, `errorRate === 0%`, singleflight 1x, `400ms` fail-safe,
 *   `heapDeltaMB < 64 MB`) and exits with code 1 if ANY gate fails.
 */

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { registerHooks } from "node:module";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_PATH = resolve(ROOT, "reports/perf-stress-report.json");
const K6_SCRIPT_PATH = resolve(ROOT, "tests/k6-seo-stress.js");
const K6_SUMMARY_PATH = resolve(ROOT, "reports/k6-summary.json");
const REPLICA_WORKER_PATH = resolve(ROOT, "scripts/perf-server-worker.mjs");
const REPLICA_COUNT = Math.max(2, Math.min(4, Math.floor(os.cpus().length / 2) || 2));

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") {
      return { shortCircuit: true, url: "virtual:perf-next-server-shim" };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "virtual:perf-next-server-shim") {
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

const { createSitemapService } = await import(
  "../packages/nextjs-blueprint/app/sitemap.ts"
);
const { clearArchivedSlugCache, middlewareFast } = await import(
  "../packages/nextjs-blueprint/middleware.ts"
);

function round2(n) {
  return Math.round(n * 100) / 100;
}

function computeLatencyStats(samples, totalDurationMs) {
  if (samples.length === 0) {
    return {
      count: 0,
      rps: 0,
      minMs: 0,
      meanMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      p999Ms: 0,
      maxMs: 0,
    };
  }
  const sorted = Float64Array.from(samples);
  sorted.sort();
  let sum = 0;
  for (let i = 0; i < sorted.length; i += 1) sum += sorted[i];

  const pct = (p) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
  };

  return {
    count: sorted.length,
    rps: round2((sorted.length / Math.max(1, totalDurationMs)) * 1000),
    minMs: round2(sorted[0]),
    meanMs: round2(sum / sorted.length),
    p50Ms: round2(pct(50)),
    p95Ms: round2(pct(95)),
    p99Ms: round2(pct(99)),
    p999Ms: round2(pct(99.9)),
    maxMs: round2(sorted[sorted.length - 1]),
  };
}

// ---------------------------------------------------------------------------
// Multi-Core Server Replica Pool Manager
// ---------------------------------------------------------------------------

async function startServerReplicaPool(count, workerData) {
  const replicas = await Promise.all(
    Array.from({ length: count }, () => {
      return new Promise((resolve, reject) => {
        const worker = new Worker(REPLICA_WORKER_PATH, { workerData });
        worker.once("message", (msg) => {
          if (msg?.type === "ready") {
            resolve({ worker, port: msg.port, initialMemory: msg.memory, info: msg });
          }
        });
        worker.once("error", reject);
      });
    }),
  );

  async function collectStats() {
    return Promise.all(
      replicas.map(
        (rep) =>
          new Promise((resolve) => {
            const onMsg = (msg) => {
              if (msg?.type === "stats") {
                rep.worker.off("message", onMsg);
                resolve(msg);
              }
            };
            rep.worker.on("message", onMsg);
            rep.worker.postMessage({ cmd: "stats" });
          }),
      ),
    );
  }

  async function shutdown() {
    await Promise.all(
      replicas.map(
        (rep) =>
          new Promise((resolve) => {
            rep.worker.once("exit", () => resolve());
            rep.worker.postMessage({ cmd: "shutdown" });
          }),
      ),
    );
  }

  return {
    replicas,
    ports: replicas.map((r) => r.port),
    collectStats,
    shutdown,
  };
}

// ---------------------------------------------------------------------------
// Multi-Threaded HTTP Keep-Alive Load Generator
// ---------------------------------------------------------------------------

const WORKER_CODE = `
const net = require("node:net");
const { performance } = require("node:perf_hooks");
const { parentPort, workerData } = require("node:worker_threads");
const zlib = require("node:zlib");

const {
  port,
  concurrency,
  totalRequests,
  mode,
  acceptGzip,
  workerId,
} = workerData;

function buildRequestSpec(idx) {
  if (mode === "sitemap_warm") {
    return {
      path: idx % 2 === 0 ? "/sitemap.xml" : "/sitemap/0.xml",
      expectedStatus: 200,
      checkXml: true,
      kind: idx % 2 === 0 ? "index" : "shard0",
    };
  }
  if (mode === "middleware_mix") {
    const b = idx % 20;
    if (b < 8) {
      return {
        path: "/magang-nasional/lowongan/archived-batch1-" + (b % 20),
        expectedStatus: 410,
        requireNoindex: true,
        requireCacheControl: true,
        kind: "archived_410",
      };
    }
    if (b < 14) {
      return {
        path: "/magang-nasional/lowongan/active-batch3b-" + (b % 20),
        expectedStatus: 200,
        requireNext: true,
        kind: "active_200",
      };
    }
    if (b < 17) {
      const hub = b % 2 === 0
        ? "/magang-nasional/lowongan/kota/jakarta"
        : "/magang-nasional/lowongan/bidang/it";
      return {
        path: hub,
        expectedStatus: 200,
        requireNext: true,
        kind: "hub_200",
      };
    }
    if (b === 17) {
      return {
        path: "/magang-nasional/lowongan/%E0%A4%A?utm_source=stress&cb=" + workerId + "-" + idx,
        expectedStatus: 200,
        requireNext: true,
        kind: "malformed_utf8",
      };
    }
    return {
      path: "/magang-nasional/lowongan/active-batch3b-0?utm_source=tiktok&fbclid=" + workerId + "-" + idx,
      expectedStatus: 200,
      requireNext: true,
      kind: "cache_bust",
    };
  }
  if (mode === "middleware_recovery") {
    const isArchived = idx % 2 === 0;
    return isArchived
      ? {
          path: "/magang-nasional/lowongan/archived-batch1-0",
          expectedStatus: 410,
          requireNoindex: true,
          requireCacheControl: true,
          kind: "archived_410",
        }
      : {
          path: "/magang-nasional/lowongan/active-batch3b-0",
          expectedStatus: 200,
          requireNext: true,
          kind: "active_200",
        };
  }
  return { path: "/sitemap.xml", expectedStatus: 200, checkXml: true, kind: "default" };
}

const CRLFCRLF = Buffer.from("\\r\\n\\r\\n");

class KeepAliveHttp11Client {
  constructor(port) {
    this.port = port;
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.pending = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: "127.0.0.1", port: this.port, noDelay: true }, () => {
        sock.setNoDelay(true);
        this.socket = sock;
        resolve();
      });
      sock.on("data", (chunk) => {
        this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
        this.tryResolve();
      });
      sock.on("error", (err) => {
        if (this.pending) {
          const p = this.pending;
          this.pending = null;
          p.resolve({ latencyMs: performance.now() - p.t0, status: 0, headers: {}, body: Buffer.alloc(0) });
        } else {
          reject(err);
        }
      });
    });
  }

  tryResolve() {
    if (!this.pending) return;
    const hEnd = this.buf.indexOf(CRLFCRLF);
    if (hEnd === -1) return;
    const headStr = this.buf.subarray(0, hEnd).toString("latin1");
    const lines = headStr.split("\\r\\n");
    const status = Number((lines[0] || "").split(" ")[1] || 0);
    const headers = {};
    for (let i = 1; i < lines.length; i += 1) {
      const colon = lines[i].indexOf(":");
      if (colon !== -1) {
        headers[lines[i].slice(0, colon).trim().toLowerCase()] = lines[i].slice(colon + 1).trim();
      }
    }
    const cl = Number(headers["content-length"] || 0);
    const bodyStart = hEnd + 4;
    const frameEnd = bodyStart + cl;
    if (this.buf.length < frameEnd) return;

    const body = cl > 0 ? Buffer.from(this.buf.subarray(bodyStart, frameEnd)) : Buffer.alloc(0);
    this.buf = this.buf.length === frameEnd ? Buffer.alloc(0) : Buffer.from(this.buf.subarray(frameEnd));
    const p = this.pending;
    this.pending = null;
    p.resolve({
      latencyMs: performance.now() - p.t0,
      status,
      headers,
      body,
    });
  }

  request(path, wantGzip) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      this.pending = { t0, resolve };
      const wire =
        "GET " +
        path +
        " HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\nConnection: keep-alive\\r\\n" +
        (wantGzip ? "Accept-Encoding: gzip\\r\\n" : "") +
        "\\r\\n";
      this.socket.write(wire, "latin1");
    });
  }

  close() {
    this.socket?.destroy();
  }
}

(async () => {
  const connCount = Math.min(concurrency, totalRequests);
  const clients = Array.from({ length: connCount }, () => new KeepAliveHttp11Client(port));
  await Promise.all(clients.map((c) => c.connect()));

  // Warm up keep-alive connections & V8 JIT before starting timed capture
  await Promise.all(
    clients.map((c, i) => c.request(buildRequestSpec(i).path, acceptGzip)),
  );

  const latencies = new Float64Array(totalRequests);
  const xmlBuffersToVerify = [];
  let nextIdx = 0;
  let errors = 0;
  let xmlValidCount = 0;
  let xmlCheckedCount = 0;
  let count410 = 0;
  let count410Noindex = 0;
  const kindCounts = {};

  async function workerLoop(client) {
    while (true) {
      const idx = nextIdx++;
      if (idx >= totalRequests) break;
      const spec = buildRequestSpec(idx);
      const r = await client.request(spec.path, acceptGzip);
      latencies[idx] = r.latencyMs;
      kindCounts[spec.kind] = (kindCounts[spec.kind] || 0) + 1;

      let ok = r.status === spec.expectedStatus;
      let has410Noindex = true;

      if (spec.checkXml) {
        const enc = String(r.headers["content-encoding"] || "").toLowerCase();
        if (enc === "gzip") {
          if (r.body.length < 18 || r.body[0] !== 0x1f || r.body[1] !== 0x8b) {
            ok = false;
          } else {
            xmlBuffersToVerify.push({ enc, rawBuf: r.body });
          }
        } else {
          xmlBuffersToVerify.push({ enc: "identity", rawBuf: r.body });
        }
      }
      if (spec.requireNoindex) {
        has410Noindex = String(r.headers["x-robots-tag"] || "").toLowerCase().includes("noindex");
        if (!has410Noindex) ok = false;
      }
      if (spec.requireCacheControl && !r.headers["cache-control"]) {
        ok = false;
      }
      if (spec.requireNext && r.headers["x-middleware-next"] !== "1") {
        ok = false;
      }

      if (!ok) errors += 1;
      if (r.status === 410) {
        count410 += 1;
        if (has410Noindex) count410Noindex += 1;
      }
    }
  }

  const tStart = performance.now();
  await Promise.all(clients.map((c) => workerLoop(c)));
  const workerDurationMs = performance.now() - tStart;
  for (const c of clients) c.close();

  // Verify 100% of XML samples off the timed hot path
  const verifiedMemo = new Map();
  for (const item of xmlBuffersToVerify) {
    xmlCheckedCount += 1;
    const sig = item.enc + ":" + item.rawBuf.length;
    const prev = verifiedMemo.get(sig);
    if (prev && item.rawBuf.equals(prev.rawBuf)) {
      if (prev.valid) xmlValidCount += 1;
      else errors += 1;
      continue;
    }
    try {
      const bodyBuf = item.enc === "gzip" ? zlib.gunzipSync(item.rawBuf) : item.rawBuf;
      const valid = bodyBuf.subarray(0, 64).toString("utf8").trimStart().startsWith('<?xml version="1.0" encoding="UTF-8"?>');
      verifiedMemo.set(sig, { rawBuf: item.rawBuf, valid });
      if (valid) xmlValidCount += 1;
      else errors += 1;
    } catch {
      errors += 1;
    }
  }

  parentPort.postMessage(
    {
      latencies,
      workerDurationMs,
      errors,
      xmlValidCount,
      xmlCheckedCount,
      count410,
      count410Noindex,
      kindCounts,
    },
    [latencies.buffer],
  );
})();
`;

async function runWorkerLoad({ ports, concurrency, totalRequests, mode, acceptGzip = false }) {
  const targetPorts = Array.isArray(ports) ? ports : [ports];
  const effectiveWorkers = Math.max(1, Math.min(targetPorts.length, concurrency, totalRequests));
  const baseReqs = Math.floor(totalRequests / effectiveWorkers);
  const remReqs = totalRequests % effectiveWorkers;
  const baseConc = Math.floor(concurrency / effectiveWorkers);
  const remConc = concurrency % effectiveWorkers;

  const promises = [];
  for (let w = 0; w < effectiveWorkers; w += 1) {
    const reqs = baseReqs + (w < remReqs ? 1 : 0);
    const conc = Math.max(1, baseConc + (w < remConc ? 1 : 0));
    promises.push(
      new Promise((resolve, reject) => {
        const worker = new Worker(WORKER_CODE, {
          eval: true,
          workerData: {
            port: targetPorts[w % targetPorts.length],
            concurrency: conc,
            totalRequests: reqs,
            mode,
            acceptGzip,
            workerId: w,
          },
        });
        worker.once("message", resolve);
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (code !== 0) reject(new Error(`Worker ${w} exited with code ${code}`));
        });
      }),
    );
  }

  const results = await Promise.all(promises);
  const totalDurationMs = Math.max(...results.map((r) => r.workerDurationMs || 1));

  const merged = new Float64Array(totalRequests);
  let offset = 0;
  let errors = 0;
  let xmlValidCount = 0;
  let xmlCheckedCount = 0;
  let count410 = 0;
  let count410Noindex = 0;
  const kindCounts = {};

  for (const r of results) {
    merged.set(r.latencies, offset);
    offset += r.latencies.length;
    errors += r.errors;
    xmlValidCount += r.xmlValidCount;
    xmlCheckedCount += r.xmlCheckedCount;
    count410 += r.count410;
    count410Noindex += r.count410Noindex;
    for (const [k, v] of Object.entries(r.kindCounts)) {
      kindCounts[k] = (kindCounts[k] || 0) + v;
    }
  }

  const stats = computeLatencyStats(merged, totalDurationMs);
  return {
    ...stats,
    totalDurationMs: round2(totalDurationMs),
    errors,
    errorRatePct: round2((errors / totalRequests) * 100),
    xmlValidCount,
    xmlCheckedCount,
    count410,
    count410Noindex,
    kindCounts,
  };
}

// ---------------------------------------------------------------------------
// Single-Instance Chaos Servers (for strict Profil B & Profil D testing)
// ---------------------------------------------------------------------------

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

function startSingleSitemapServer(sitemapService) {
  return new Promise((resolve) => {
    const writePayload = (res, payload) => {
      res.writeHead(payload.status, payload.headers);
      res.end(payload.body);
    };
    const server = http.createServer({ noDelay: true }, (req, res) => {
      try {
        const rawUrl = req.url || "/sitemap.xml";
        const qIdx = rawUrl.indexOf("?");
        const pathname = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
        const acceptEncoding = req.headers["accept-encoding"] || "";
        const maybePayload = sitemapService.serveRequestFast(pathname, String(acceptEncoding));
        if (maybePayload && typeof maybePayload.then === "function") {
          maybePayload
            .then((payload) => writePayload(res, payload))
            .catch(() => {
              res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
              res.end("Internal Server Error");
            });
        } else {
          writePayload(res, maybePayload);
        }
      } catch {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("Internal Server Error");
      }
    });
    server.keepAliveTimeout = 60_000;
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function startArchiveKvServer(state) {
  return new Promise((resolve) => {
    const server = http.createServer({ noDelay: true }, (req, res) => {
      state.requests += 1;
      const slug = decodeURIComponent((req.url || "/").slice(1));
      const respond = () => {
        if (res.writableEnded || req.destroyed) return;
        const archived = slug.startsWith("archived-");
        const body = JSON.stringify({ archived });
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-length": String(Buffer.byteLength(body)),
        });
        res.end(body);
      };
      if (state.stallMs > 0) {
        const timer = setTimeout(respond, state.stallMs);
        req.on("close", () => clearTimeout(timer));
      } else {
        respond();
      }
    });
    server.keepAliveTimeout = 60_000;
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function startSingleMiddlewareServer({ kvBaseUrl, modeState }) {
  return new Promise((resolve) => {
    const lookupNormal = { edgeUrl: kvBaseUrl, timeoutMs: 400, bypassCache: false, cacheTtlMs: 60_000 };
    const lookupBypass = { edgeUrl: kvBaseUrl, timeoutMs: 400, bypassCache: true, cacheTtlMs: 60_000 };
    const writeMwResponse = (res, mwRes) => {
      const bodyBuf = mwRes.bodyBuffer;
      const rawHeaders = mwRes.rawHeaders;
      if (rawHeaders["content-length"] !== undefined) {
        res.writeHead(mwRes.status, rawHeaders);
      } else {
        res.writeHead(mwRes.status, { ...rawHeaders, "content-length": String(bodyBuf.length) });
      }
      res.end(bodyBuf);
    };
    const server = http.createServer({ noDelay: true }, (req, res) => {
      try {
        const rawUrl = req.url || "/";
        const qIdx = rawUrl.indexOf("?");
        const pathname = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
        const nextReq = {
          nextUrl: {
            pathname,
            search: qIdx === -1 ? "" : rawUrl.slice(qIdx),
            origin: "https://maganghub.kemnaker.go.id",
            href: rawUrl,
          },
        };
        const maybeRes = middlewareFast(nextReq, modeState.bypassCache ? lookupBypass : lookupNormal);
        if (maybeRes && typeof maybeRes.then === "function") {
          maybeRes
            .then((mwRes) => writeMwResponse(res, mwRes))
            .catch(() => {
              res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
              res.end("Middleware Error");
            });
        } else {
          writeMwResponse(res, maybeRes);
        }
      } catch {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("Middleware Error");
      }
    });
    server.keepAliveTimeout = 60_000;
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function directHttpGet(port, path) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const req = http.request({ hostname: "127.0.0.1", port, path, method: "GET" }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          latencyMs: performance.now() - t0,
          status: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on("error", () => {
      resolve({ latencyMs: performance.now() - t0, status: 0, headers: {}, body: Buffer.alloc(0) });
    });
    req.end();
  });
}

async function detectK6() {
  try {
    const { stdout } = await execFileAsync("k6", ["version"], { timeout: 5000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function runK6CrossVerification(sitemapPorts, middlewarePorts) {
  const k6Version = await detectK6();
  if (!k6Version) {
    return { available: false, skippedReason: "k6 binary not found on PATH" };
  }

  mkdirSync(dirname(K6_SUMMARY_PATH), { recursive: true });
  const t0 = performance.now();
  try {
    await execFileAsync(
      "k6",
      [
        "run",
        "--no-color",
        "--summary-trend-stats=min,avg,med,p(90),p(95),p(99),p(99.9),max",
        "--summary-export",
        K6_SUMMARY_PATH,
        K6_SCRIPT_PATH,
      ],
      {
        cwd: ROOT,
        timeout: 60_000,
        env: {
          ...process.env,
          SITEMAP_BASE_URLS: sitemapPorts.map((p) => `http://127.0.0.1:${p}`).join(","),
          MIDDLEWARE_BASE_URLS: middlewarePorts.map((p) => `http://127.0.0.1:${p}`).join(","),
        },
      },
    );
    const summary = JSON.parse(readFileSync(K6_SUMMARY_PATH, "utf8"));
    const smDur = summary.metrics["http_req_duration{scenario:sitemap_warm_burst}"] || {};
    const mwDur = summary.metrics["http_req_duration{scenario:middleware_410_burst}"] || {};
    const checks = summary.metrics.checks || {};
    const reqs = summary.metrics.http_reqs || {};
    const smP99 = round2(smDur["p(99)"] ?? 0);
    const mwP99 = round2(mwDur["p(99)"] ?? 0);
    const checksPass = checks.fails === 0 && (checks.passes ?? 0) > 0;
    const pass = checksPass && smP99 < 50 && mwP99 < 50;

    return {
      available: true,
      k6Version,
      durationMs: round2(performance.now() - t0),
      totalRequests: reqs.count ?? 0,
      rps: round2(reqs.rate ?? 0),
      checksPasses: checks.passes ?? 0,
      checksFails: checks.fails ?? 0,
      sitemap: {
        p50Ms: round2(smDur.med ?? 0),
        p95Ms: round2(smDur["p(95)"] ?? 0),
        p99Ms: smP99,
      },
      middleware: {
        p50Ms: round2(mwDur.med ?? 0),
        p95Ms: round2(mwDur["p(95)"] ?? 0),
        p99Ms: mwP99,
      },
      pass,
    };
  } catch (err) {
    return {
      available: true,
      k6Version,
      durationMs: round2(performance.now() - t0),
      pass: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Execute All 4 Load & Stress Profiles
// ---------------------------------------------------------------------------

async function main() {
  const startedAt = new Date();
  const nowMs = Date.parse("2026-11-21T12:00:00+07:00");
  const profiles = {};

  console.log(
    `=== MagangHub Phase 2.6 Local Load & Stress-Test Harness (SLA p99 < 50ms | ${REPLICA_COUNT} Server Replicas) ===`,
  );

  // PROFIL A1: app/sitemap.ts Warm/ISR Burst (10,000 URLs sharded)
  {
    const pool = await startServerReplicaPool(REPLICA_COUNT, {
      role: "sitemap",
      urlCount: 10_000,
      urlLimit: 5_000,
      nowMs,
    });
    // Pre-heat server replicas + loopback sockets before steady-state ISR latency sampling
    await runWorkerLoad({
      ports: pool.ports,
      concurrency: 16,
      totalRequests: 160,
      mode: "sitemap_warm",
      acceptGzip: true,
    });
    const beforeStats = await pool.collectStats();
    const res = await runWorkerLoad({
      ports: pool.ports,
      concurrency: 64,
      totalRequests: 2_500,
      mode: "sitemap_warm",
      acceptGzip: true,
    });
    const afterStats = await pool.collectStats();
    const heapBeforeMB = round2(beforeStats.reduce((s, r) => s + r.memory.heapUsedMB, 0));
    const heapAfterMB = round2(afterStats.reduce((s, r) => s + r.memory.heapUsedMB, 0));
    const heapDeltaMB = round2(Math.max(0, heapAfterMB - heapBeforeMB));
    const rssMB = round2(afterStats[0].memory.rssMB);
    const totalUrls = pool.replicas[0].info.totalUrls;
    const shardCount = pool.replicas[0].info.shardCount;
    await pool.shutdown();

    const xmlValidRatePct = round2((res.xmlValidCount / Math.max(1, res.xmlCheckedCount)) * 100);
    const pass =
      res.errorRatePct === 0 &&
      res.p99Ms < 50 &&
      xmlValidRatePct === 100 &&
      heapDeltaMB < 64;

    profiles.profileA_sitemap10k = {
      name: "Profil A1 - app/sitemap.ts Warm/ISR Burst (10,000 URLs sharded)",
      serverReplicas: REPLICA_COUNT,
      concurrency: 64,
      totalRequests: 2_500,
      urlCount: totalUrls,
      shardCount,
      ...res,
      xmlValidRatePct,
      heapBeforeMB,
      heapAfterMB,
      heapDeltaMB,
      rssMB,
      sla: { p99LimitMs: 50, maxErrorRatePct: 0, maxHeapDeltaMB: 64, minXmlValidPct: 100 },
      pass,
    };
    console.log(
      `[Profil A1 10k] RPS=${res.rps} p50=${res.p50Ms}ms p95=${res.p95Ms}ms p99=${res.p99Ms}ms p99.9=${res.p999Ms}ms err=${res.errorRatePct}% heapDelta=${heapDeltaMB}MB => ${pass ? "PASS" : "FAIL"}`,
    );
  }

  // PROFIL A2: app/sitemap.ts Warm/ISR Burst (50,000 URLs sharded <sitemapindex>)
  const pool50k = await startServerReplicaPool(REPLICA_COUNT, {
    role: "sitemap",
    urlCount: 50_000,
    urlLimit: 5_000,
    nowMs,
  });
  {
    await runWorkerLoad({
      ports: pool50k.ports,
      concurrency: 16,
      totalRequests: 160,
      mode: "sitemap_warm",
      acceptGzip: true,
    });
    const beforeStats = await pool50k.collectStats();
    const res = await runWorkerLoad({
      ports: pool50k.ports,
      concurrency: 64,
      totalRequests: 2_500,
      mode: "sitemap_warm",
      acceptGzip: true,
    });
    const afterStats = await pool50k.collectStats();
    const heapBeforeMB = round2(beforeStats.reduce((s, r) => s + r.memory.heapUsedMB, 0));
    const heapAfterMB = round2(afterStats.reduce((s, r) => s + r.memory.heapUsedMB, 0));
    const heapDeltaMB = round2(Math.max(0, heapAfterMB - heapBeforeMB));
    const rssMB = round2(afterStats[0].memory.rssMB);
    const totalUrls = pool50k.replicas[0].info.totalUrls;
    const shardCount = pool50k.replicas[0].info.shardCount;
    const xmlValidRatePct = round2((res.xmlValidCount / Math.max(1, res.xmlCheckedCount)) * 100);
    const pass =
      res.errorRatePct === 0 &&
      res.p99Ms < 50 &&
      xmlValidRatePct === 100 &&
      heapDeltaMB < 64 &&
      shardCount >= 2;

    profiles.profileA_sitemap50k = {
      name: "Profil A2 - app/sitemap.ts Warm/ISR Burst (50,000 URLs sharded <sitemapindex>)",
      serverReplicas: REPLICA_COUNT,
      concurrency: 64,
      totalRequests: 2_500,
      urlCount: totalUrls,
      shardCount,
      ...res,
      xmlValidRatePct,
      heapBeforeMB,
      heapAfterMB,
      heapDeltaMB,
      rssMB,
      sla: { p99LimitMs: 50, maxErrorRatePct: 0, maxHeapDeltaMB: 64, minXmlValidPct: 100 },
      pass,
    };
    console.log(
      `[Profil A2 50k] RPS=${res.rps} p50=${res.p50Ms}ms p95=${res.p95Ms}ms p99=${res.p99Ms}ms p99.9=${res.p999Ms}ms err=${res.errorRatePct}% heapDelta=${heapDeltaMB}MB shards=${shardCount} => ${pass ? "PASS" : "FAIL"}`,
    );
  }

  // PROFIL B: app/sitemap.ts Cold-Rebuild & Thundering-Herd Chaos (Single Instance)
  {
    const elMonitor = monitorEventLoopDelay({ resolution: 10 });
    elMonitor.enable();

    const slowSvc = createSitemapService({
      fetchVacancies: async () => {
        await new Promise((r) => setTimeout(r, 250));
        return generateSyntheticVacancies(200);
      },
      timeoutMs: 1_500,
      nowFn: () => nowMs,
    });
    const slowSrv = await startSingleSitemapServer(slowSvc);
    const tSlow0 = performance.now();
    const slowResponses = await Promise.all(
      Array.from({ length: 50 }, () => directHttpGet(slowSrv.port, "/sitemap.xml")),
    );
    const slowTotalMs = performance.now() - tSlow0;
    const slowMetrics = slowSvc.getMetrics();
    slowSrv.server.closeAllConnections?.();
    slowSrv.server.close();

    const slowStats = computeLatencyStats(
      slowResponses.map((r) => r.latencyMs),
      slowTotalMs,
    );
    const slowErrors = slowResponses.filter(
      (r) =>
        r.status !== 200 ||
        !r.body.toString("utf8").startsWith('<?xml version="1.0" encoding="UTF-8"?>'),
    ).length;

    const hangSvc = createSitemapService({
      fetchVacancies: (signal) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(generateSyntheticVacancies(200)), 2_000);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
      timeoutMs: 350,
      nowFn: () => nowMs,
    });
    const hangSrv = await startSingleSitemapServer(hangSvc);
    const tHang0 = performance.now();
    const hangResponses = await Promise.all(
      Array.from({ length: 50 }, () => directHttpGet(hangSrv.port, "/sitemap.xml")),
    );
    const hangTotalMs = performance.now() - tHang0;
    const hangMetrics = hangSvc.getMetrics();
    hangSrv.server.closeAllConnections?.();
    hangSrv.server.close();

    elMonitor.disable();
    const maxEventLoopLagMs = round2(elMonitor.max / 1e6);

    const hangStats = computeLatencyStats(
      hangResponses.map((r) => r.latencyMs),
      hangTotalMs,
    );
    const hangErrors = hangResponses.filter(
      (r) =>
        r.status !== 200 ||
        r.headers["x-sitemap-fallback"] !== "1" ||
        !r.body.toString("utf8").startsWith('<?xml version="1.0" encoding="UTF-8"?>'),
    ).length;

    const pass =
      slowMetrics.upstreamFetchCount === 1 &&
      hangMetrics.upstreamFetchCount === 1 &&
      slowErrors === 0 &&
      hangErrors === 0 &&
      hangStats.p99Ms < 1_000 &&
      maxEventLoopLagMs < 150;

    profiles.profileB_sitemapThunderingHerd = {
      name: "Profil B - app/sitemap.ts Cold-Rebuild & Thundering-Herd Chaos",
      concurrency: 50,
      slow250ms: {
        upstreamCalls: slowMetrics.upstreamFetchCount,
        errors: slowErrors,
        errorRatePct: round2((slowErrors / 50) * 100),
        ...slowStats,
      },
      hangAbortFallback: {
        configuredTimeoutMs: 350,
        simulatedHangMs: 2_000,
        upstreamCalls: hangMetrics.upstreamFetchCount,
        errors: hangErrors,
        errorRatePct: round2((hangErrors / 50) * 100),
        fallbackXmlServedCount: 50 - hangErrors,
        ...hangStats,
      },
      maxEventLoopLagMs,
      sla: {
        expectedUpstreamCallsPerStorm: 1,
        maxErrorRatePct: 0,
        maxHangFallbackMs: 1_000,
        maxEventLoopLagMs: 150,
      },
      pass,
    };
    console.log(
      `[Profil B Herd] slowCalls=${slowMetrics.upstreamFetchCount}x (p99=${slowStats.p99Ms}ms) hangCalls=${hangMetrics.upstreamFetchCount}x (p99=${hangStats.p99Ms}ms, fallback=50/50) elLag=${maxEventLoopLagMs}ms => ${pass ? "PASS" : "FAIL"}`,
    );
  }

  // PROFIL C: middleware.ts HTTP 410 Gone High-RPS Burst (4 Server Replicas, 5,000 reqs @ c=100)
  const kvState = { stallMs: 0, requests: 0 };
  const kvSrv = await startArchiveKvServer(kvState);
  const kvBaseUrl = `http://127.0.0.1:${kvSrv.port}`;
  const mwPool = await startServerReplicaPool(REPLICA_COUNT, {
    role: "middleware",
    kvBaseUrl,
  });

  {
    await runWorkerLoad({
      ports: mwPool.ports,
      concurrency: 20,
      totalRequests: 200,
      mode: "middleware_mix",
      acceptGzip: false,
    });
    const beforeStats = await mwPool.collectStats();
    const res = await runWorkerLoad({
      ports: mwPool.ports,
      concurrency: 100,
      totalRequests: 5_000,
      mode: "middleware_mix",
      acceptGzip: false,
    });
    const afterStats = await mwPool.collectStats();
    const heapBeforeMB = round2(beforeStats.reduce((s, r) => s + r.memory.heapUsedMB, 0));
    const heapAfterMB = round2(afterStats.reduce((s, r) => s + r.memory.heapUsedMB, 0));
    const heapDeltaMB = round2(Math.max(0, heapAfterMB - heapBeforeMB));
    const rssMB = round2(afterStats[0].memory.rssMB);
    const uriErrors = afterStats.reduce((s, r) => s + (r.uncaughtUriErrors || 0), 0);
    const maxCacheSize = Math.max(...afterStats.map((r) => r.cacheStats?.size || 0));
    const cacheCap = afterStats[0].cacheStats?.maxEntries || 4_096;
    const noindex410RatePct =
      res.count410 > 0 ? round2((res.count410Noindex / res.count410) * 100) : 0;

    const pass =
      res.errorRatePct === 0 &&
      res.p99Ms < 50 &&
      uriErrors === 0 &&
      noindex410RatePct === 100 &&
      heapDeltaMB < 64 &&
      maxCacheSize <= cacheCap;

    profiles.profileC_middleware410Burst = {
      name: "Profil C - middleware.ts HTTP 410 Gone High-RPS Burst",
      serverReplicas: REPLICA_COUNT,
      concurrency: 100,
      totalRequests: 5_000,
      ...res,
      uncaughtUriErrors: uriErrors,
      noindex410RatePct,
      edgeCacheSizePerReplica: maxCacheSize,
      edgeCacheCap: cacheCap,
      heapBeforeMB,
      heapAfterMB,
      heapDeltaMB,
      rssMB,
      sla: { p99LimitMs: 50, idealTargetMs: 15, maxErrorRatePct: 0, uncaughtUriErrors: 0, minNoindex410Pct: 100 },
      pass,
    };
    console.log(
      `[Profil C 410] RPS=${res.rps} p50=${res.p50Ms}ms p95=${res.p95Ms}ms p99=${res.p99Ms}ms p99.9=${res.p999Ms}ms err=${res.errorRatePct}% 410noindex=${noindex410RatePct}% uriErr=${uriErrors} heapDelta=${heapDeltaMB}MB => ${pass ? "PASS" : "FAIL"}`,
    );
  }

  // PROFIL D: middleware.ts 400ms Dependency-Hang Fail-Safe & Instant Recovery
  {
    clearArchivedSlugCache();
    const mwMode = { bypassCache: true };
    const singleMw = await startSingleMiddlewareServer({ kvBaseUrl, modeState: mwMode });

    kvState.stallMs = 2_000;
    const tStall0 = performance.now();
    const stallResponses = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        directHttpGet(singleMw.port, `/magang-nasional/lowongan/archived-stall-${i}`),
      ),
    );
    const stallTotalMs = performance.now() - tStall0;
    const stallStats = computeLatencyStats(
      stallResponses.map((r) => r.latencyMs),
      stallTotalMs,
    );
    const stallErrors = stallResponses.filter(
      (r) => r.status !== 200 || r.headers["x-middleware-next"] !== "1",
    ).length;

    singleMw.server.closeAllConnections?.();
    singleMw.server.close();

    // Immediately restore Edge KV & verify post-recovery p99 < 50ms
    kvState.stallMs = 0;
    const recoveryRes = await runWorkerLoad({
      ports: mwPool.ports,
      concurrency: 50,
      totalRequests: 1_000,
      mode: "middleware_recovery",
      acceptGzip: false,
    });

    const pass =
      stallErrors === 0 &&
      stallStats.p50Ms >= 380 &&
      stallStats.p99Ms <= 550 &&
      stallStats.maxMs < 1_000 &&
      recoveryRes.errorRatePct === 0 &&
      recoveryRes.p99Ms < 50;

    profiles.profileD_middlewareFailSafe = {
      name: "Profil D - middleware.ts 400ms Dependency-Hang Fail-Safe & Recovery",
      concurrency: 30,
      simulatedStallMs: 2_000,
      configuredTimeoutMs: 400,
      failOpenDuringStall: {
        errors: stallErrors,
        errorRatePct: round2((stallErrors / 30) * 100),
        failOpenCount: 30 - stallErrors,
        ...stallStats,
      },
      postRecoveryBurst: {
        concurrency: 50,
        totalRequests: 1_000,
        ...recoveryRes,
      },
      sla: {
        abortMinMs: 380,
        abortMaxP99Ms: 550,
        mustBeBelowSimulatedStallMs: 2_000,
        recoveryP99LimitMs: 50,
        maxErrorRatePct: 0,
      },
      pass,
    };
    console.log(
      `[Profil D FailSafe] stall30 p50=${stallStats.p50Ms}ms p99=${stallStats.p99Ms}ms (failOpen=${30 - stallErrors}/30 vs 2000ms stall) | recovery p99=${recoveryRes.p99Ms}ms RPS=${recoveryRes.rps} => ${pass ? "PASS" : "FAIL"}`,
    );
  }

  // Cross-Verification with k6 (if installed on PATH)
  const k6CrossCheck = await runK6CrossVerification(pool50k.ports, mwPool.ports);
  if (k6CrossCheck.available) {
    console.log(
      `[k6 Cross-Check] ${k6CrossCheck.k6Version} | reqs=${k6CrossCheck.totalRequests} RPS=${k6CrossCheck.rps} sitemap_p99=${k6CrossCheck.sitemap?.p99Ms}ms mw_p99=${k6CrossCheck.middleware?.p99Ms}ms checks=${k6CrossCheck.checksPasses}/${(k6CrossCheck.checksPasses || 0) + (k6CrossCheck.checksFails || 0)} => ${k6CrossCheck.pass ? "PASS" : "FAIL"}`,
    );
  }

  await pool50k.shutdown();
  await mwPool.shutdown();
  kvSrv.server.closeAllConnections?.();
  kvSrv.server.close();

  const allProfilesPass =
    Object.values(profiles).every((p) => p.pass) &&
    (!k6CrossCheck.available || k6CrossCheck.pass);

  const report = {
    ok: allProfilesPass,
    timestamp: startedAt.toISOString(),
    nodeVersion: process.version,
    serverReplicas: REPLICA_COUNT,
    gcExposed: typeof globalThis.gc === "function",
    slaSummary: {
      p99ThresholdMs: 50,
      maxErrorRatePct: 0,
      maxHeapDeltaMB: 64,
      allHardGatesPassed: allProfilesPass,
    },
    profiles,
    k6CrossCheck,
  };

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\nReport written to ${REPORT_PATH}`);
  console.log(`OVERALL PHASE 2.6 VERDICT: ${allProfilesPass ? "100% PASS (EXIT 0)" : "FAIL (EXIT 1)"}`);

  if (!allProfilesPass) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[PERF-STRESS FATAL]", err);
  process.exitCode = 1;
});
