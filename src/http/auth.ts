import {
  InvalidTokenError,
  ServerError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { config } from '../lib/core.js';
import { normalizeHost } from '../lib/url.js';
import { hmacSha256Hex, timingSafeEqualUtf8 } from '../lib/utils.js';
import { isObject } from '../lib/utils.js';
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
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
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
    const { req, res } = ctx;
    const host = this.resolveHostHeader(req);

    if (!host) return this.reject(res, 400, 'Missing or invalid Host header');
    if (!ALLOWED_HOSTS.has(host))
      return this.reject(res, 403, 'Host not allowed');

    const originHeader = getHeaderValue(req, 'origin');
    if (!originHeader) return true;

    const requestOrigin = this.resolveRequestOrigin(req);
    const origin = this.resolveOrigin(originHeader);
    if (!requestOrigin || !origin)
      return this.reject(res, 403, 'Invalid Origin header');
    if (!ALLOWED_HOSTS.has(origin.host))
      return this.reject(res, 403, 'Origin not allowed');

    const isSameOrigin =
      requestOrigin.scheme === origin.scheme &&
      requestOrigin.host === origin.host &&
      requestOrigin.port === origin.port;
    if (!isSameOrigin) return this.reject(res, 403, 'Origin not allowed');

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

    const isEncrypted =
      (req.socket as { encrypted?: boolean }).encrypted === true;
    const scheme = isEncrypted ? 'https' : 'http';
    try {
      const parsed = new URL(`${scheme}://${hostHeader}`);
      const normalizedHost = normalizeHost(parsed.host);
      if (!normalizedHost) return null;

      return {
        scheme,
        host: normalizedHost,
        port: parsed.port || this.defaultPortForScheme(scheme),
      };
    } catch {
      return null;
    }
  }

  private resolveOrigin(
    origin: string
  ): { scheme: 'http' | 'https'; host: string; port: string } | null {
    if (origin === 'null') return null;
    try {
      const parsed = new URL(origin);
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
    } catch {
      return null;
    }
  }

  private defaultPortForScheme(scheme: 'http' | 'https'): string {
    return scheme === 'https' ? '443' : '80';
  }

  private reject(
    res: ServerResponse,
    status: number,
    message: string
  ): boolean {
    sendJson(res, status, { error: message });
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
    throw new Error(
      'ALLOW_REMOTE must be true to bind to non-loopback interfaces'
    );
  }

  if (isRemoteBinding && config.auth.mode !== 'oauth') {
    throw new Error('OAuth authentication is required for remote bindings');
  }

  if (config.auth.mode === 'static' && config.auth.staticTokens.length === 0) {
    throw new Error(
      'Static auth requires ACCESS_TOKENS or API_KEY to be configured'
    );
  }
}

// ---------------------------------------------------------------------------
// MCP protocol version
// ---------------------------------------------------------------------------

const DEFAULT_MCP_PROTOCOL_VERSION = '2025-11-25';
const LEGACY_MCP_PROTOCOL_VERSION = '2025-03-26';
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = new Set<string>([
  DEFAULT_MCP_PROTOCOL_VERSION,
  LEGACY_MCP_PROTOCOL_VERSION,
]);

interface McpProtocolVersionCheckOptions {
  requireHeader?: boolean;
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
  const requireHeader = options?.requireHeader ?? false;

  if (!version) {
    if (!requireHeader) {
      // Permissive backward-compat fallback: clients predating MCP 2025-03-26 do not
      // send MCP-Protocol-Version. Accepting requests without the header keeps older
      // integrations working. Pass requireHeader: true to enforce strict version checking.
      return true;
    }

    sendError(res, -32600, 'Missing MCP-Protocol-Version header');
    return false;
  }

  if (!SUPPORTED_MCP_PROTOCOL_VERSIONS.has(version)) {
    sendError(res, -32600, `Unsupported MCP-Protocol-Version: ${version}`);
    return false;
  }

  const expectedVersion = options?.expectedVersion;
  if (expectedVersion && version !== expectedVersion) {
    sendError(
      res,
      -32600,
      `MCP-Protocol-Version mismatch: expected ${expectedVersion}, got ${version}`
    );
    return false;
  }

  return true;
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

class AuthService {
  private readonly staticTokenDigests = config.auth.staticTokens.map((token) =>
    hmacSha256Hex(STATIC_TOKEN_HMAC_KEY, token)
  );

  async authenticate(
    req: IncomingMessage,
    signal?: AbortSignal
  ): Promise<AuthInfo> {
    const authHeader = getHeaderValue(req, 'authorization');
    if (!authHeader) {
      return this.authenticateWithApiKey(req);
    }

    const token = this.resolveBearerToken(authHeader);
    return this.authenticateWithToken(token, signal);
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
      throw new InvalidTokenError('X-API-Key not supported for OAuth');
    }

    throw new InvalidTokenError('Missing Authorization header');
  }

  private resolveBearerToken(authHeader: string): string {
    if (!authHeader.startsWith('Bearer ')) {
      throw new InvalidTokenError('Invalid Authorization header format');
    }
    const token = authHeader.substring(7);
    if (!token) {
      throw new InvalidTokenError('Invalid Authorization header format');
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
      throw new InvalidTokenError('No static tokens configured');
    }

    const tokenDigest = hmacSha256Hex(STATIC_TOKEN_HMAC_KEY, token);
    const matched = hasConstantTimeMatch(this.staticTokenDigests, tokenDigest);

    if (!matched) throw new InvalidTokenError('Invalid token');
    return this.buildStaticAuthInfo(token);
  }

  private stripHash(url: URL): string {
    const clean = new URL(url);
    clean.hash = '';
    return clean.href;
  }

  private buildBasicAuthHeader(
    clientId: string,
    clientSecret: string | undefined
  ): string {
    // Base64 is only an encoding for header transport; it is NOT encryption.
    const credentials = `${clientId}:${clientSecret ?? ''}`;
    return `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;
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
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;

    const response = await fetch(url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: combinedSignal,
    });

    if (!response.ok) {
      if (response.body) {
        await response.body.cancel();
      }
      throw new ServerError(`Token introspection failed: ${response.status}`);
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

  private async verifyWithIntrospection(
    token: string,
    signal?: AbortSignal
  ): Promise<AuthInfo> {
    if (!config.auth.introspectionUrl) {
      throw new ServerError('Introspection not configured');
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
      throw new InvalidTokenError('Token is inactive');
    }

    return this.buildIntrospectionAuthInfo(token, payload);
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
  const resourceMetadata = buildResourceMetadataUrl(req);
  res.setHeader(
    'WWW-Authenticate',
    `Bearer resource_metadata="${resourceMetadata}"`
  );
}

export function buildProtectedResourceMetadataDocument(req: IncomingMessage): {
  resource: string;
  resource_metadata: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported: string[];
} {
  const urls = buildRequestScopedProtectedResourceUrls(req);

  return {
    resource: urls.resource,
    resource_metadata: urls.resourceMetadata,
    authorization_servers: config.auth.issuerUrl
      ? [config.auth.issuerUrl.href]
      : [],
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
