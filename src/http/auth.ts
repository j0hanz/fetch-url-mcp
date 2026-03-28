import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  InvalidTokenError,
  ServerError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

import { config, logDebug, logWarn } from '../lib/core.js';
import { Loggers } from '../lib/logger-names.js';
import { normalizeHost } from '../lib/url.js';
import {
  composeAbortSignal,
  hmacSha256Hex,
  isObject,
  parseUrlOrNull,
  timingSafeEqualUtf8,
} from '../lib/utils.js';

import {
  getHeaderValue,
  type RequestContext,
  sendEmpty,
  sendError,
  sendJson,
} from './helpers.js';

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

class CorsPolicy {
  // NOTE: CorsPolicy.handle() is invoked only AFTER hostOriginPolicy.validate() in
  // HttpRequestPipeline. The Origin header is reflected only when it matches an
  // allowlisted host — arbitrary/unauthenticated origins are never reflected.
  handle(ctx: RequestContext): boolean {
    const { req, res } = ctx;
    const origin = getHeaderValue(req, 'origin');

    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-API-Key, MCP-Protocol-Version, MCP-Session-ID, X-MCP-Session-ID, Last-Event-ID'
    );
    res.setHeader(
      'Access-Control-Expose-Headers',
      'MCP-Session-ID, X-MCP-Session-ID, MCP-Protocol-Version, WWW-Authenticate'
    );

    if (req.method !== 'OPTIONS') return false;
    sendEmpty(res, 204);
    return true;
  }
}

export const corsPolicy = new CorsPolicy();

// ---------------------------------------------------------------------------
// Host / Origin validation
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::']);

class InsufficientScopeError extends InvalidTokenError {
  constructor(
    readonly requiredScopes: readonly string[],
    message = 'Insufficient scope'
  ) {
    super(message);
    this.name = 'InsufficientScopeError';
  }
}

export function isInsufficientScopeError(
  error: unknown
): error is InsufficientScopeError {
  return error instanceof InsufficientScopeError;
}

function hasConstantTimeMatch(
  candidates: readonly string[],
  input: string
): boolean {
  // Avoid leaking match index via early-return.
  let matched = 0;
  for (const candidate of candidates) {
    matched |= timingSafeEqualUtf8(candidate, input) ? 1 : 0;
  }
  return matched === 1;
}

function isWildcardHost(host: string): boolean {
  return WILDCARD_HOSTS.has(host);
}

function addNormalizedHost(target: Set<string>, value: string): void {
  const normalized = normalizeHost(value);
  if (normalized) target.add(normalized);
}

function buildAllowedHosts(): ReadonlySet<string> {
  const allowed = new Set<string>(LOOPBACK_HOSTS);

  const configuredHost = normalizeHost(config.server.host);
  if (configuredHost && !isWildcardHost(configuredHost)) {
    allowed.add(configuredHost);
  }

  for (const host of config.security.allowedHosts) {
    addNormalizedHost(allowed, host);
  }

  return allowed;
}

const ALLOWED_HOSTS = buildAllowedHosts();

class HostOriginPolicy {
  validate(ctx: RequestContext): boolean {
    const { req } = ctx;
    const host = this.resolveHostHeader(req);

    if (!host) return this.reject(ctx, 400, 'Missing or invalid Host header');
    if (!ALLOWED_HOSTS.has(host))
      return this.reject(ctx, 403, 'Host not allowed');

    const originHeader = getHeaderValue(req, 'origin');
    if (!originHeader) return true;

    const requestOrigin = this.resolveRequestOrigin(req);
    const origin = this.resolveOrigin(originHeader);
    if (!requestOrigin || !origin) {
      return this.reject(ctx, 403, 'Invalid Origin header');
    }
    if (!ALLOWED_HOSTS.has(origin.host)) {
      return this.reject(ctx, 403, 'Origin not allowed');
    }

    const isSameOrigin =
      requestOrigin.scheme === origin.scheme &&
      requestOrigin.host === origin.host &&
      requestOrigin.port === origin.port;
    if (!isSameOrigin) return this.reject(ctx, 403, 'Origin not allowed');

    return true;
  }

  private resolveHostHeader(req: IncomingMessage): string | null {
    const host = getHeaderValue(req, 'host');
    if (!host) return null;
    return normalizeHost(host);
  }

  private resolveRequestOrigin(
    req: IncomingMessage
  ): { scheme: 'http' | 'https'; host: string; port: string } | null {
    const hostHeader = getHeaderValue(req, 'host');
    if (!hostHeader) return null;

    const isEncrypted = Reflect.get(req.socket, 'encrypted') === true;
    const scheme = isEncrypted ? 'https' : 'http';
    const parsed = parseUrlOrNull(`${scheme}://${hostHeader}`);
    if (!parsed) return null;

    const normalizedHost = normalizeHost(parsed.host);
    if (!normalizedHost) return null;

    return {
      scheme,
      host: normalizedHost,
      port: parsed.port || this.defaultPortForScheme(scheme),
    };
  }

  private resolveOrigin(
    origin: string
  ): { scheme: 'http' | 'https'; host: string; port: string } | null {
    if (origin === 'null') return null;
    const parsed = parseUrlOrNull(origin);
    if (!parsed) return null;

    const scheme = parsed.protocol === 'https:' ? 'https' : 'http';
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }

    const normalizedHost = normalizeHost(parsed.host);
    if (!normalizedHost) return null;

    return {
      scheme,
      host: normalizedHost,
      port: parsed.port || this.defaultPortForScheme(scheme),
    };
  }

  private defaultPortForScheme(scheme: 'http' | 'https'): string {
    return scheme === 'https' ? '443' : '80';
  }

  private reject(
    ctx: RequestContext,
    status: number,
    message: string
  ): boolean {
    logWarn(
      'Host/Origin policy rejection',
      {
        status,
        reason: message,
        method: ctx.method,
        path: ctx.url.pathname,
        host: getHeaderValue(ctx.req, 'host'),
        origin: getHeaderValue(ctx.req, 'origin'),
      },
      'http'
    );
    sendJson(ctx.res, status, { error: message });
    return false;
  }
}

export const hostOriginPolicy = new HostOriginPolicy();

// ---------------------------------------------------------------------------
// HTTP mode configuration guard
// ---------------------------------------------------------------------------

export function assertHttpModeConfiguration(): void {
  const configuredHost = normalizeHost(config.server.host);
  const isLoopback =
    configuredHost !== null && LOOPBACK_HOSTS.has(configuredHost);
  const isRemoteBinding = !isLoopback;

  if (isRemoteBinding && !config.security.allowRemote) {
    throw Error('ALLOW_REMOTE must be true to bind to non-loopback interfaces');
  }

  if (isRemoteBinding && config.auth.mode !== 'oauth') {
    throw Error('OAuth authentication is required for remote bindings');
  }

  if (config.auth.mode === 'oauth' && !config.auth.issuerUrl) {
    throw Error(
      'OAuth mode requires OAUTH_ISSUER_URL to serve RFC9728 metadata'
    );
  }

  if (config.auth.mode === 'static' && config.auth.staticTokens.length === 0) {
    throw Error(
      'Static auth requires ACCESS_TOKENS or API_KEY to be configured'
    );
  }
}

// ---------------------------------------------------------------------------
// MCP protocol version
// ---------------------------------------------------------------------------

export const DEFAULT_MCP_PROTOCOL_VERSION = '2025-11-25';
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = new Set<string>([
  DEFAULT_MCP_PROTOCOL_VERSION,
]);

interface McpProtocolVersionCheckOptions {
  expectedVersion?: string;
}

function resolveMcpProtocolVersion(req: IncomingMessage): string | undefined {
  const versionHeader = getHeaderValue(req, 'mcp-protocol-version');
  if (!versionHeader) return undefined;

  const version = versionHeader.trim();
  return version.length > 0 ? version : undefined;
}

export function ensureMcpProtocolVersion(
  req: IncomingMessage,
  res: ServerResponse,
  options?: McpProtocolVersionCheckOptions
): boolean {
  const version = resolveMcpProtocolVersion(req);
  const path = URL.parse(req.url ?? '', 'http://localhost')?.pathname;

  if (!version) {
    // Tolerate missing header on sessioned requests (expectedVersion set)
    // to avoid breaking older clients that don't send it yet.
    if (options?.expectedVersion) {
      return true;
    }

    logWarn(
      'MCP protocol version rejected',
      { reason: 'missing_header', path },
      'http'
    );
    sendError(
      res,
      -32600,
      'Please include the MCP-Protocol-Version header in your request.'
    );
    return false;
  }

  if (!SUPPORTED_MCP_PROTOCOL_VERSIONS.has(version)) {
    logWarn(
      'MCP protocol version rejected',
      { reason: 'unsupported_version', version, path },
      'http'
    );
    sendError(
      res,
      -32600,
      `The protocol version '${version}' isn't supported right now. Please check and try again.`
    );
    return false;
  }

  const expectedVersion = options?.expectedVersion;
  if (expectedVersion && version !== expectedVersion) {
    logWarn(
      'MCP protocol version rejected',
      {
        reason: 'version_mismatch',
        version,
        expectedVersion,
        path,
      },
      'http'
    );
    sendError(
      res,
      -32600,
      `There's a protocol version mismatch. We expected '${expectedVersion}', but received '${version}'.`
    );
    return false;
  }

  return true;
}

export function isOAuthMetadataEnabled(): boolean {
  return config.auth.mode === 'oauth';
}

// ---------------------------------------------------------------------------
// Auth fingerprint
// ---------------------------------------------------------------------------

const SESSION_AUTH_FINGERPRINT_KEY = randomBytes(32);

export function buildAuthFingerprint(
  auth: AuthInfo | undefined
): string | null {
  if (!auth) return null;

  const safeClientId = typeof auth.clientId === 'string' ? auth.clientId : '';
  const safeToken = typeof auth.token === 'string' ? auth.token : '';

  if (!safeClientId && !safeToken) return null;
  return hmacSha256Hex(
    SESSION_AUTH_FINGERPRINT_KEY,
    `${safeClientId}:${safeToken}`
  );
}

// ---------------------------------------------------------------------------
// Auth service
// ---------------------------------------------------------------------------

const STATIC_TOKEN_TTL_SECONDS = 60 * 60 * 24;
const STATIC_TOKEN_HMAC_KEY = randomBytes(32);

const INTROSPECTION_CACHE_TTL_MS = 30_000;
const INTROSPECTION_CACHE_MAX_ENTRIES = 1_000;

interface CachedIntrospection {
  readonly info: AuthInfo;
  readonly expiresAt: number;
}

class AuthService {
  private readonly staticTokenDigests = config.auth.staticTokens.map((token) =>
    hmacSha256Hex(STATIC_TOKEN_HMAC_KEY, token)
  );

  private readonly introspectionCache = new Map<string, CachedIntrospection>();

  async authenticate(
    req: IncomingMessage,
    signal?: AbortSignal
  ): Promise<AuthInfo> {
    const authHeader = getHeaderValue(req, 'authorization');
    const source = authHeader ? 'authorization' : 'api-key';
    const info = authHeader
      ? await this.authenticateWithToken(
          this.resolveBearerToken(authHeader),
          signal
        )
      : this.authenticateWithApiKey(req);

    logDebug(
      'Authentication succeeded',
      {
        mode: config.auth.mode,
        source,
        clientId: info.clientId,
        scopeCount: info.scopes.length,
      },
      Loggers.LOG_AUTH
    );

    return info;
  }

  private authenticateWithToken(
    token: string,
    signal?: AbortSignal
  ): Promise<AuthInfo> {
    return config.auth.mode === 'oauth'
      ? this.verifyWithIntrospection(token, signal)
      : Promise.resolve(this.verifyStaticToken(token));
  }

  private authenticateWithApiKey(req: IncomingMessage): AuthInfo {
    const apiKey = getHeaderValue(req, 'x-api-key');

    if (apiKey && config.auth.mode === 'static') {
      return this.verifyStaticToken(apiKey);
    }
    if (apiKey && config.auth.mode === 'oauth') {
      logWarn(
        'Auth failed: X-API-Key not supported for OAuth',
        {},
        Loggers.LOG_AUTH
      );
      const error = new InvalidTokenError('X-API-Key not supported for OAuth');
      throw error;
    }

    logWarn(
      'Auth failed: missing credentials',
      { authMode: config.auth.mode },
      Loggers.LOG_AUTH
    );
    const error = new InvalidTokenError(
      config.auth.mode === 'static'
        ? 'Missing Authorization or X-API-Key header'
        : 'Missing Authorization header'
    );
    throw error;
  }

  private resolveBearerToken(authHeader: string): string {
    if (!authHeader.startsWith('Bearer ')) {
      const error = new InvalidTokenError(
        'Invalid Authorization header format'
      );
      throw error;
    }
    const token = authHeader.substring(7);
    if (!token) {
      const error = new InvalidTokenError(
        'Invalid Authorization header format'
      );
      throw error;
    }
    return token;
  }

  private buildStaticAuthInfo(token: string): AuthInfo {
    return {
      token,
      clientId: 'static-token',
      scopes: config.auth.requiredScopes,
      expiresAt: Math.floor(Date.now() / 1000) + STATIC_TOKEN_TTL_SECONDS,
      resource: config.auth.resourceUrl,
    };
  }

  private verifyStaticToken(token: string): AuthInfo {
    if (this.staticTokenDigests.length === 0) {
      const error = new InvalidTokenError('No static tokens configured');
      throw error;
    }

    const tokenDigest = hmacSha256Hex(STATIC_TOKEN_HMAC_KEY, token);
    const matched = hasConstantTimeMatch(this.staticTokenDigests, tokenDigest);

    if (!matched) {
      logWarn('Auth failed: invalid static token', {}, Loggers.LOG_AUTH);
      const error = new InvalidTokenError('Invalid token');
      throw error;
    }
    return this.buildStaticAuthInfo(token);
  }

  private stripHash(url: URL): string {
    const clean = new URL(url);
    clean.hash = '';
    return clean.href;
  }

  private canonicalizeResourceUri(value: string): string | null {
    if (!URL.canParse(value)) return null;

    const url = new URL(value);
    url.hash = '';
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();

    const { href } = url;
    if (url.pathname === '/' && !url.search && href.endsWith('/')) {
      return href.slice(0, -1);
    }

    return href;
  }

  private readAudienceValues(payload: Record<string, unknown>): string[] {
    const values: string[] = [];
    for (const key of ['aud', 'resource'] as const) {
      const raw = payload[key];
      if (typeof raw === 'string') {
        values.push(raw);
        continue;
      }
      if (!Array.isArray(raw)) continue;

      values.push(
        ...raw.filter((value): value is string => typeof value === 'string')
      );
    }
    return values;
  }

  private assertTokenAudience(payload: Record<string, unknown>): void {
    const expected = this.canonicalizeResourceUri(
      this.stripHash(config.auth.resourceUrl)
    );
    if (!expected) {
      const error = new ServerError('Configured resource URL is invalid');
      throw error;
    }

    const audiences = this.readAudienceValues(payload)
      .map((value) => this.canonicalizeResourceUri(value))
      .filter((value): value is string => value !== null);

    if (audiences.length === 0) {
      logWarn(
        'Auth failed: token missing audience binding',
        {},
        Loggers.LOG_AUTH
      );
      const error = new InvalidTokenError('Token missing audience binding');
      throw error;
    }
    if (!audiences.includes(expected)) {
      logWarn('Auth failed: audience mismatch', {}, Loggers.LOG_AUTH);
      const error = new InvalidTokenError(
        'Token audience does not match this MCP server'
      );
      throw error;
    }
  }

  private buildBasicAuthHeader(
    clientId: string,
    clientSecret: string | undefined
  ): string {
    // Base64 is only an encoding for header transport; it is NOT encryption.
    const credentials = `${clientId}:${clientSecret ?? ''}`;
    return `Basic ${btoa(credentials)}`;
  }

  private buildIntrospectionRequest(
    token: string,
    resourceUrl: URL,
    clientId: string | undefined,
    clientSecret: string | undefined
  ): { body: string; headers: Record<string, string> } {
    const body = new URLSearchParams({
      token,
      token_type_hint: 'access_token',
      resource: this.stripHash(resourceUrl),
    }).toString();

    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
    };

    if (clientId) {
      headers['authorization'] = this.buildBasicAuthHeader(
        clientId,
        clientSecret
      );
    }

    return { body, headers };
  }

  private async requestIntrospection(
    url: URL,
    request: { body: string; headers: Record<string, string> },
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<unknown> {
    const introspectionSignal = composeAbortSignal(signal, timeoutMs);

    const response = await fetch(url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      ...(introspectionSignal ? { signal: introspectionSignal } : {}),
    });

    if (!response.ok) {
      if (response.body) {
        await response.body.cancel();
      }
      logWarn(
        'Token introspection HTTP error',
        { status: response.status },
        Loggers.LOG_AUTH
      );
      const error = new ServerError(
        `Token introspection failed: ${response.status}`
      );
      throw error;
    }

    return response.json();
  }

  private buildIntrospectionAuthInfo(
    token: string,
    payload: Record<string, unknown>
  ): AuthInfo {
    const { exp, client_id: clientIdRaw, scope: scopeRaw } = payload;
    const expiresAt = typeof exp === 'number' ? exp : undefined;
    const clientId = typeof clientIdRaw === 'string' ? clientIdRaw : 'unknown';

    const info: AuthInfo = {
      token,
      clientId,
      scopes: typeof scopeRaw === 'string' ? scopeRaw.split(' ') : [],
      resource: config.auth.resourceUrl,
    };

    if (expiresAt !== undefined) info.expiresAt = expiresAt;
    return info;
  }

  private assertRequiredScopes(tokenScopes: string[]): void {
    const { requiredScopes } = config.auth;
    if (requiredScopes.length === 0) return;

    const tokenScopeSet = new Set(tokenScopes);
    const missing = requiredScopes.filter((s) => !tokenScopeSet.has(s));
    if (missing.length > 0) {
      logWarn(
        'Auth failed: insufficient scopes',
        { missingCount: missing.length },
        Loggers.LOG_AUTH
      );
      const error = new InsufficientScopeError(missing);
      throw error;
    }
  }

  private async verifyWithIntrospection(
    token: string,
    signal?: AbortSignal
  ): Promise<AuthInfo> {
    if (!config.auth.introspectionUrl) {
      const error = new ServerError('Introspection not configured');
      throw error;
    }

    const cacheKey = hmacSha256Hex(STATIC_TOKEN_HMAC_KEY, token);
    const cached = this.introspectionCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      this.introspectionCache.delete(cacheKey);
      this.introspectionCache.set(cacheKey, cached);
      logDebug('Token introspection cache hit', {}, Loggers.LOG_AUTH);
      return cached.info;
    }

    const req = this.buildIntrospectionRequest(
      token,
      config.auth.resourceUrl,
      config.auth.clientId,
      config.auth.clientSecret
    );

    const payload = await this.requestIntrospection(
      config.auth.introspectionUrl,
      req,
      config.auth.introspectionTimeoutMs,
      signal
    );

    if (!isObject(payload) || payload['active'] !== true) {
      this.introspectionCache.delete(cacheKey);
      logWarn('Auth failed: token inactive', {}, Loggers.LOG_AUTH);
      const error = new InvalidTokenError('Token is inactive');
      throw error;
    }

    this.assertTokenAudience(payload);

    const info = this.buildIntrospectionAuthInfo(token, payload);
    this.assertRequiredScopes(info.scopes);

    logDebug(
      'Token introspection successful',
      { clientId: info.clientId },
      Loggers.LOG_AUTH
    );

    this.evictStaleEntries();
    this.introspectionCache.set(cacheKey, {
      info,
      expiresAt: Date.now() + INTROSPECTION_CACHE_TTL_MS,
    });

    return info;
  }

  private evictStaleEntries(): void {
    if (this.introspectionCache.size < INTROSPECTION_CACHE_MAX_ENTRIES) return;

    const now = Date.now();
    for (const [key, entry] of this.introspectionCache) {
      if (entry.expiresAt <= now) this.introspectionCache.delete(key);
    }

    if (this.introspectionCache.size >= INTROSPECTION_CACHE_MAX_ENTRIES) {
      const oldest = this.introspectionCache.keys().next();
      if (!oldest.done) this.introspectionCache.delete(oldest.value);
    }
  }
}

function resolvePublicOrigin(req: IncomingMessage): string {
  const host = getHeaderValue(req, 'host');
  if (host) {
    const protocol = config.server.https.enabled ? 'https' : 'http';
    return `${protocol}://${host}`;
  }

  return config.auth.resourceUrl.origin;
}

function buildRequestScopedProtectedResourceUrls(req: IncomingMessage): {
  resource: string;
  resourceMetadata: string;
} {
  const origin = resolvePublicOrigin(req);
  return {
    resource: new URL('/mcp', `${origin}/`).href,
    resourceMetadata: new URL(resolveResourceMetadataPath(), `${origin}/`).href,
  };
}

function resolveResourceMetadataPath(): string {
  return '/.well-known/oauth-protected-resource/mcp';
}

function buildResourceMetadataUrl(req: IncomingMessage): string {
  return buildRequestScopedProtectedResourceUrls(req).resourceMetadata;
}

export function applyUnauthorizedAuthHeaders(
  req: IncomingMessage,
  res: ServerResponse
): void {
  if (!isOAuthMetadataEnabled()) return;

  const resourceMetadata = buildResourceMetadataUrl(req);
  const challengeParts = [`resource_metadata="${resourceMetadata}"`];
  if (config.auth.requiredScopes.length > 0) {
    challengeParts.push(`scope="${config.auth.requiredScopes.join(' ')}"`);
  }

  res.setHeader('WWW-Authenticate', `Bearer ${challengeParts.join(', ')}`);
}

export function applyInsufficientScopeAuthHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  requiredScopes: readonly string[],
  message = 'Additional authorization scope is required'
): void {
  if (!isOAuthMetadataEnabled()) return;

  const resourceMetadata = buildResourceMetadataUrl(req);
  const challengeParts = [
    'error="insufficient_scope"',
    `scope="${requiredScopes.join(' ')}"`,
    `resource_metadata="${resourceMetadata}"`,
    `error_description="${message.replaceAll('"', "'")}"`,
  ];

  res.setHeader('WWW-Authenticate', `Bearer ${challengeParts.join(', ')}`);
}

export function buildProtectedResourceMetadataDocument(req: IncomingMessage): {
  resource: string;
  resource_metadata: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported: string[];
} {
  const urls = buildRequestScopedProtectedResourceUrls(req);
  if (!config.auth.issuerUrl) {
    const error = new ServerError(
      'OAuth issuer URL is required for protected resource metadata'
    );
    throw error;
  }

  return {
    resource: urls.resource,
    resource_metadata: urls.resourceMetadata,
    authorization_servers: [config.auth.issuerUrl.href],
    bearer_methods_supported: ['header'],
    scopes_supported: config.auth.requiredScopes,
  };
}

export function isProtectedResourceMetadataPath(pathname: string): boolean {
  return (
    pathname === '/.well-known/oauth-protected-resource' ||
    pathname === '/.well-known/oauth-protected-resource/mcp'
  );
}

export const authService = new AuthService();
