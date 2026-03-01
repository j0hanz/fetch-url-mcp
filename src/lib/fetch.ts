/**
 * Public facade for HTTP fetching infrastructure.
 *
 * Implementation is split across focused modules:
 *   - url-security.ts       – IP blocking, URL normalization
 *   - raw-url-transformer.ts – Git-platform raw URL conversion
 *   - dns-resolver.ts       – Safe DNS resolution with CNAME validation
 *   - fetch-errors.ts       – Error classification & mapping
 *   - fetch-telemetry.ts    – Diagnostics-channel telemetry
 *   - fetch-redirect.ts     – Redirect following with per-hop validation
 *   - fetch-response.ts     – Response reading, decompression, content-type
 *
 * This file wires singletons and re-exports the public API so that
 * consumers only need `import { ... } from './fetch.js'`.
 */
import { config } from './config.js';
import { createDnsPreflight, SafeDnsResolver } from './dns-resolver.js';
import { mapFetchError } from './fetch-errors.js';
import { RedirectFollower } from './fetch-redirect.js';
import {
  decodeResponseIfNeeded,
  readAndRecordDecodedResponse,
  ResponseTextReader,
} from './fetch-response.js';
import {
  FetchTelemetry,
  type FetchTelemetryContext,
} from './fetch-telemetry.js';
import {
  getOperationId,
  getRequestId,
  logDebug,
  logError,
  logWarn,
  redactUrl,
} from './observability.js';
import {
  RawUrlTransformer,
  type TransformResult,
} from './raw-url-transformer.js';
import {
  BLOCKED_HOST_SUFFIXES,
  IpBlocker,
  type Logger,
  UrlNormalizer,
} from './url-security.js';

// ---------------------------------------------------------------------------
// Shared defaults
// ---------------------------------------------------------------------------

interface FetchOptions {
  signal?: AbortSignal;
}

const defaultLogger: Logger = {
  debug: logDebug,
  warn: logWarn,
  error: logError,
};

const defaultContext = {
  getRequestId,
  getOperationId,
};

const defaultRedactor = {
  redact: redactUrl,
};

const defaultFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> => globalThis.fetch(input, init);

// ---------------------------------------------------------------------------
// HttpFetcher – orchestrates a full fetch cycle
// ---------------------------------------------------------------------------

type FetcherConfig = typeof config.fetcher;

interface FetchBufferResult {
  buffer: Uint8Array;
  encoding: string;
  truncated: boolean;
  finalUrl: string;
}

type FetchReadMode = 'text' | 'buffer';
type FetchReadResult = string | FetchBufferResult;

class HttpFetcher {
  constructor(
    private readonly fetcherConfig: FetcherConfig,
    private readonly redirectFollower: RedirectFollower,
    private readonly reader: ResponseTextReader,
    private readonly telemetry: FetchTelemetry
  ) {}

  async fetchNormalizedUrl(
    normalizedUrl: string,
    options?: FetchOptions
  ): Promise<string> {
    return this.fetchNormalized(normalizedUrl, 'text', options);
  }

  async fetchNormalizedUrlBuffer(
    normalizedUrl: string,
    options?: FetchOptions
  ): Promise<FetchBufferResult> {
    return this.fetchNormalized(normalizedUrl, 'buffer', options);
  }

  private async fetchNormalized(
    normalizedUrl: string,
    mode: 'text',
    options?: FetchOptions
  ): Promise<string>;
  private async fetchNormalized(
    normalizedUrl: string,
    mode: 'buffer',
    options?: FetchOptions
  ): Promise<FetchBufferResult>;
  private async fetchNormalized(
    normalizedUrl: string,
    mode: FetchReadMode,
    options?: FetchOptions
  ): Promise<FetchReadResult> {
    const timeoutMs = this.fetcherConfig.timeout;
    const headers = buildHeaders();
    const signal = buildRequestSignal(timeoutMs, options?.signal);
    const init = buildRequestInit(headers, signal);

    const ctx = this.telemetry.start(normalizedUrl, 'GET');

    try {
      const { response, url: finalUrl } =
        await this.redirectFollower.fetchWithRedirects(
          normalizedUrl,
          init,
          this.fetcherConfig.maxRedirects
        );

      ctx.url = this.telemetry.redact(finalUrl);
      return await this.readPayload(
        response,
        finalUrl,
        ctx,
        mode,
        init.signal ?? undefined
      );
    } catch (error: unknown) {
      const mapped = mapFetchError(error, normalizedUrl, timeoutMs);
      ctx.url = this.telemetry.redact(mapped.url);
      this.telemetry.recordError(ctx, mapped, mapped.statusCode);
      throw mapped;
    }
  }

  private async readPayload(
    response: Response,
    finalUrl: string,
    ctx: FetchTelemetryContext,
    mode: FetchReadMode,
    signal?: AbortSignal
  ): Promise<FetchReadResult> {
    try {
      const payload = await readAndRecordDecodedResponse(
        response,
        finalUrl,
        ctx,
        this.telemetry,
        this.reader,
        this.fetcherConfig.maxContentLength,
        mode,
        signal
      );

      if (payload.kind === 'text') return payload.text;

      return {
        buffer: payload.buffer,
        encoding: payload.encoding,
        truncated: payload.truncated,
        finalUrl,
      };
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Request building helpers
// ---------------------------------------------------------------------------

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': config.fetcher.userAgent,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate, br',
  Connection: 'keep-alive',
};

function buildHeaders(): Record<string, string> {
  return DEFAULT_HEADERS;
}

function buildRequestSignal(
  timeoutMs: number,
  external?: AbortSignal
): AbortSignal | undefined {
  if (timeoutMs <= 0) return external;

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([external, timeoutSignal]) : timeoutSignal;
}

function buildRequestInit(
  headers: HeadersInit,
  signal?: AbortSignal
): RequestInit {
  return {
    method: 'GET',
    headers,
    ...(signal ? { signal } : {}),
  };
}

// ---------------------------------------------------------------------------
// Singleton wiring
// ---------------------------------------------------------------------------

const ipBlocker = new IpBlocker(config.security);
const urlNormalizer = new UrlNormalizer(
  config.constants,
  config.security,
  ipBlocker,
  BLOCKED_HOST_SUFFIXES
);
const rawUrlTransformer = new RawUrlTransformer(defaultLogger);
const dnsResolver = new SafeDnsResolver(
  ipBlocker,
  config.security,
  BLOCKED_HOST_SUFFIXES
);
const telemetry = new FetchTelemetry(
  defaultLogger,
  defaultContext,
  defaultRedactor
);
const normalizeRedirectUrl = (url: string): string =>
  urlNormalizer.validateAndNormalize(url);
const dnsPreflight = createDnsPreflight(dnsResolver);

// Redirect follower with per-hop DNS preflight.
const secureRedirectFollower = new RedirectFollower(
  defaultFetch,
  normalizeRedirectUrl,
  dnsPreflight
);

const responseReader = new ResponseTextReader();
const httpFetcher = new HttpFetcher(
  config.fetcher,
  secureRedirectFollower,
  responseReader,
  telemetry
);

// ---------------------------------------------------------------------------
// Public API exports
// ---------------------------------------------------------------------------

export function isBlockedIp(ip: string): boolean {
  return ipBlocker.isBlockedIp(ip);
}

export function normalizeUrl(urlString: string): {
  normalizedUrl: string;
  hostname: string;
} {
  return urlNormalizer.normalize(urlString);
}

export function validateAndNormalizeUrl(urlString: string): string {
  return urlNormalizer.validateAndNormalize(urlString);
}

export function transformToRawUrl(url: string): TransformResult {
  return rawUrlTransformer.transformToRawUrl(url);
}

export function isRawTextContentUrl(url: string): boolean {
  return rawUrlTransformer.isRawTextContentUrl(url);
}

export function startFetchTelemetry(
  url: string,
  method: string
): FetchTelemetryContext {
  return telemetry.start(url, method);
}

export function recordFetchResponse(
  context: FetchTelemetryContext,
  response: Response,
  contentSize?: number
): void {
  telemetry.recordResponse(context, response, contentSize);
}

export function recordFetchError(
  context: FetchTelemetryContext,
  error: unknown,
  status?: number
): void {
  telemetry.recordError(context, error, status);
}

export async function fetchWithRedirects(
  url: string,
  init: RequestInit,
  maxRedirects: number
): Promise<{ response: Response; url: string }> {
  return secureRedirectFollower.fetchWithRedirects(url, init, maxRedirects);
}

export async function readResponseText(
  response: Response,
  url: string,
  maxBytes: number,
  signal?: AbortSignal,
  encoding?: string
): Promise<{ text: string; size: number }> {
  const decodedResponse = await decodeResponseIfNeeded(response, url, signal);
  const { text, size } = await responseReader.read(
    decodedResponse,
    url,
    maxBytes,
    signal,
    encoding
  );
  return { text, size };
}

export async function fetchNormalizedUrl(
  normalizedUrl: string,
  options?: FetchOptions
): Promise<string> {
  return httpFetcher.fetchNormalizedUrl(normalizedUrl, options);
}

export async function fetchNormalizedUrlBuffer(
  normalizedUrl: string,
  options?: FetchOptions
): Promise<{
  buffer: Uint8Array;
  encoding: string;
  truncated: boolean;
  finalUrl: string;
}> {
  return httpFetcher.fetchNormalizedUrlBuffer(normalizedUrl, options);
}
