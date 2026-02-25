import type { ServerResponse } from 'node:http';
import { freemem, hostname, totalmem } from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import process from 'node:process';

import { keys as cacheKeys } from '../cache.js';
import { config, serverVersion } from '../config.js';
import type { SessionStore } from '../session.js';
import { getTransformPoolStats } from '../transform/transform.js';
import { type RequestContext, sendJson } from './helpers.js';

// ---------------------------------------------------------------------------
// Event-loop monitoring
// ---------------------------------------------------------------------------

const EVENT_LOOP_DELAY_RESOLUTION_MS = 20;
const eventLoopDelay = monitorEventLoopDelay({
  resolution: EVENT_LOOP_DELAY_RESOLUTION_MS,
});
let lastEventLoopUtilization = performance.eventLoopUtilization();

export function resetEventLoopMonitoring(): void {
  lastEventLoopUtilization = performance.eventLoopUtilization();
  eventLoopDelay.reset();
  eventLoopDelay.enable();
}

export function disableEventLoopMonitoring(): void {
  eventLoopDelay.disable();
}

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------

function roundTo(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function formatEventLoopUtilization(
  snapshot: ReturnType<typeof performance.eventLoopUtilization>
): { utilization: number; activeMs: number; idleMs: number } {
  return {
    utilization: roundTo(snapshot.utilization, 4),
    activeMs: Math.round(snapshot.active),
    idleMs: Math.round(snapshot.idle),
  };
}

function toMs(valueNs: number): number {
  return roundTo(valueNs / 1_000_000, 3);
}

function getEventLoopStats(): {
  utilization: {
    total: { utilization: number; activeMs: number; idleMs: number };
    sinceLast: { utilization: number; activeMs: number; idleMs: number };
  };
  delay: {
    minMs: number;
    maxMs: number;
    meanMs: number;
    stddevMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  };
} {
  const current = performance.eventLoopUtilization();
  const delta = performance.eventLoopUtilization(
    current,
    lastEventLoopUtilization
  );
  lastEventLoopUtilization = current;

  return {
    utilization: {
      total: formatEventLoopUtilization(current),
      sinceLast: formatEventLoopUtilization(delta),
    },
    delay: {
      minMs: toMs(eventLoopDelay.min),
      maxMs: toMs(eventLoopDelay.max),
      meanMs: toMs(eventLoopDelay.mean),
      stddevMs: toMs(eventLoopDelay.stddev),
      p50Ms: toMs(eventLoopDelay.percentile(50)),
      p95Ms: toMs(eventLoopDelay.percentile(95)),
      p99Ms: toMs(eventLoopDelay.percentile(99)),
    },
  };
}

// ---------------------------------------------------------------------------
// Health response building
// ---------------------------------------------------------------------------

interface HealthResponse {
  status: 'ok';
  version: string;
  uptime: number;
  timestamp: string;
  os?: {
    hostname: string;
    platform: NodeJS.Platform;
    arch: string;
    memoryFree: number;
    memoryTotal: number;
  };
  process?: {
    pid: number;
    ppid: number;
    memory: NodeJS.MemoryUsage;
    cpu: NodeJS.CpuUsage;
    resource: NodeJS.ResourceUsage;
  };
  perf?: ReturnType<typeof getEventLoopStats>;
  stats?: {
    activeSessions: number;
    cacheKeys: number;
    workerPool: {
      queueDepth: number;
      activeWorkers: number;
      capacity: number;
    };
  };
}

function buildHealthResponse(
  store: SessionStore,
  includeDiagnostics: boolean
): HealthResponse {
  const base: HealthResponse = {
    status: 'ok',
    version: serverVersion,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  };

  if (!includeDiagnostics) return base;

  const poolStats = getTransformPoolStats();
  return {
    ...base,
    os: {
      hostname: hostname(),
      platform: process.platform,
      arch: process.arch,
      memoryFree: freemem(),
      memoryTotal: totalmem(),
    },
    process: {
      pid: process.pid,
      ppid: process.ppid,
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
      resource: process.resourceUsage(),
    },
    perf: getEventLoopStats(),
    stats: {
      activeSessions: store.size(),
      cacheKeys: cacheKeys().length,
      workerPool: poolStats ?? {
        queueDepth: 0,
        activeWorkers: 0,
        capacity: 0,
      },
    },
  };
}

function sendHealth(
  store: SessionStore,
  res: ServerResponse,
  includeDiagnostics: boolean
): void {
  res.setHeader('Cache-Control', 'no-store');
  sendJson(res, 200, buildHealthResponse(store, includeDiagnostics));
}

// ---------------------------------------------------------------------------
// Health route helpers
// ---------------------------------------------------------------------------

function isVerboseHealthRequest(ctx: RequestContext): boolean {
  const value = ctx.url.searchParams.get('verbose');
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

function isGetHealthRoute(ctx: RequestContext): boolean {
  return ctx.method === 'GET' && ctx.url.pathname === '/health';
}

function isVerboseHealthRoute(ctx: RequestContext): boolean {
  return isGetHealthRoute(ctx) && isVerboseHealthRequest(ctx);
}

function isHealthRoute(ctx: RequestContext): boolean {
  return isGetHealthRoute(ctx);
}

function ensureHealthAuthIfNeeded(
  ctx: RequestContext,
  authPresent: boolean
): boolean {
  if (!isHealthRoute(ctx)) return true;
  const isVerbose = isVerboseHealthRequest(ctx);

  if (!isVerbose) return true;
  if (!config.security.allowRemote) return true;
  if (authPresent) return true;

  sendJson(ctx.res, 401, {
    error: 'Authentication required for verbose health metrics',
  });
  return false;
}

function resolveHealthDiagnosticsMode(
  ctx: RequestContext,
  authPresent: boolean
): boolean {
  if (!isVerboseHealthRoute(ctx)) return false;
  if (authPresent) return true;
  return !config.security.allowRemote;
}

export function shouldHandleHealthRoute(ctx: RequestContext): boolean {
  return isGetHealthRoute(ctx);
}

export function sendHealthRouteResponse(
  store: SessionStore,
  ctx: RequestContext,
  authPresent: boolean
): boolean {
  if (!shouldHandleHealthRoute(ctx)) return false;
  if (!ensureHealthAuthIfNeeded(ctx, authPresent)) return true;

  const includeDiagnostics = resolveHealthDiagnosticsMode(ctx, authPresent);
  sendHealth(store, ctx.res, includeDiagnostics);
  return true;
}
