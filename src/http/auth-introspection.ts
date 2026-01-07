import {
  InvalidTokenError,
  ServerError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

import { config } from '../config/index.js';

import { isRecord } from '../utils/guards.js';

function stripHash(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = '';
  return copy.href;
}

function parseScopes(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(' ')
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0);
  }

  if (Array.isArray(value)) {
    return value.filter((scope): scope is string => typeof scope === 'string');
  }

  return [];
}

function parseResourceUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string') return undefined;
  if (!URL.canParse(value)) return undefined;
  return new URL(value);
}

function extractResource(data: Record<string, unknown>): URL | undefined {
  const resource = parseResourceUrl(data.resource);
  if (resource) return resource;

  const { aud } = data;
  if (typeof aud === 'string') {
    return parseResourceUrl(aud);
  }

  if (Array.isArray(aud)) {
    for (const entry of aud) {
      const parsed = parseResourceUrl(entry);
      if (parsed) return parsed;
    }
  }

  return undefined;
}

function extractScopes(data: Record<string, unknown>): string[] {
  if (data.scope !== undefined) {
    return parseScopes(data.scope);
  }

  if (data.scopes !== undefined) {
    return parseScopes(data.scopes);
  }

  if (data.scp !== undefined) {
    return parseScopes(data.scp);
  }

  return [];
}

function readExpiresAt(data: Record<string, unknown>): number {
  const expiresAt = typeof data.exp === 'number' ? data.exp : Number.NaN;
  if (!Number.isFinite(expiresAt)) {
    throw new InvalidTokenError('Token has no expiration time');
  }
  return expiresAt;
}

function resolveClientId(data: Record<string, unknown>): string {
  if (typeof data.client_id === 'string') return data.client_id;
  if (typeof data.cid === 'string') return data.cid;
  if (typeof data.sub === 'string') return data.sub;
  return 'unknown';
}

function ensureResourceMatch(resource: URL | undefined): URL | undefined {
  if (resource && stripHash(resource) !== stripHash(config.auth.resourceUrl)) {
    throw new InvalidTokenError('Token resource mismatch');
  }
  return resource;
}

function buildIntrospectionAuthInfo(
  token: string,
  data: Record<string, unknown>
): AuthInfo {
  const resource = ensureResourceMatch(extractResource(data));

  return {
    token,
    clientId: resolveClientId(data),
    scopes: extractScopes(data),
    expiresAt: readExpiresAt(data),
    resource: resource ?? config.auth.resourceUrl,
    extra: data,
  };
}

interface IntrospectionRequest {
  body: string;
  headers: Record<string, string>;
}

function buildBasicAuthHeader(
  clientId: string,
  clientSecret: string | undefined
): string {
  const secret = clientSecret ?? '';
  const basic = Buffer.from(`${clientId}:${secret}`, 'utf8').toString('base64');
  return `Basic ${basic}`;
}

function buildIntrospectionRequest(
  token: string,
  resourceUrl: URL,
  clientId: string | undefined,
  clientSecret: string | undefined
): IntrospectionRequest {
  const body = new URLSearchParams({
    token,
    token_type_hint: 'access_token',
    resource: stripHash(resourceUrl),
  }).toString();
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (clientId) {
    headers.authorization = buildBasicAuthHeader(clientId, clientSecret);
  }

  return { body, headers };
}

async function requestIntrospection(
  introspectionUrl: URL,
  request: IntrospectionRequest,
  timeoutMs: number
): Promise<unknown> {
  const response = await fetch(introspectionUrl, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    await response.body?.cancel();
    throw new ServerError(`Token introspection failed: ${response.status}`);
  }

  return response.json();
}

function parseIntrospectionPayload(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload) || Array.isArray(payload)) {
    throw new ServerError('Invalid introspection response');
  }
  if (payload.active !== true) {
    throw new InvalidTokenError('Token is inactive');
  }
  return payload;
}

export async function verifyWithIntrospection(
  token: string
): Promise<AuthInfo> {
  const { auth } = config;
  if (!auth.introspectionUrl) {
    throw new ServerError('Token introspection is not configured');
  }
  const request = buildIntrospectionRequest(
    token,
    auth.resourceUrl,
    auth.clientId,
    auth.clientSecret
  );
  const payload = await requestIntrospection(
    auth.introspectionUrl,
    request,
    auth.introspectionTimeoutMs
  );
  return buildIntrospectionAuthInfo(token, parseIntrospectionPayload(payload));
}
