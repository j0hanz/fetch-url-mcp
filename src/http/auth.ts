import type {
  NextFunction,
  Request,
  RequestHandler,
  Response,
  Router,
} from 'express';

import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

import { config } from '../config/index.js';

import { verifyWithIntrospection } from './auth-introspection.js';
import { verifyStaticToken } from './auth-static.js';

function normalizeHeaderValue(
  header: string | string[] | undefined
): string | undefined {
  return Array.isArray(header) ? header[0] : header;
}

function getApiKeyHeader(req: Request): string | null {
  const apiKeyHeader = normalizeHeaderValue(req.headers['x-api-key']);
  return apiKeyHeader ? apiKeyHeader.trim() : null;
}

function createLegacyApiKeyMiddleware(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (config.auth.mode !== 'static') {
      next();
      return;
    }

    if (!req.headers.authorization) {
      const apiKey = getApiKeyHeader(req);
      if (apiKey) {
        req.headers.authorization = `Bearer ${apiKey}`;
      }
    }

    next();
  };
}

async function verifyAccessToken(token: string): Promise<AuthInfo> {
  if (config.auth.mode === 'oauth') {
    return verifyWithIntrospection(token);
  }

  return verifyStaticToken(token);
}

function resolveMetadataUrl(): string | null {
  if (config.auth.mode !== 'oauth') return null;
  return getOAuthProtectedResourceMetadataUrl(new URL(config.auth.resourceUrl));
}

function resolveOptionalScopes(
  requiredScopes: readonly string[]
): string[] | undefined {
  return requiredScopes.length > 0 ? [...requiredScopes] : undefined;
}

type OAuthAuthConfig = typeof config.auth;

function resolveOAuthMetadataParams(
  authConfig: OAuthAuthConfig
): OAuthMetadataParams | null {
  const {
    issuerUrl,
    authorizationUrl,
    tokenUrl,
    revocationUrl,
    registrationUrl,
    requiredScopes,
  } = authConfig;

  if (!issuerUrl || !authorizationUrl || !tokenUrl) return null;

  return {
    issuerUrl,
    authorizationUrl,
    tokenUrl,
    revocationUrl,
    registrationUrl,
    requiredScopes,
  };
}

interface OAuthMetadata extends Record<string, unknown> {
  issuer: string;
  authorization_endpoint: string;
  response_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint: string;
  token_endpoint_auth_methods_supported: string[];
  grant_types_supported: string[];
  scopes_supported?: string[];
  revocation_endpoint?: string;
  registration_endpoint?: string;
}

interface OAuthMetadataParams {
  issuerUrl: URL;
  authorizationUrl: URL;
  tokenUrl: URL;
  revocationUrl: URL | undefined;
  registrationUrl: URL | undefined;
  requiredScopes: readonly string[];
}

type OptionalEndpointKey = 'revocation_endpoint' | 'registration_endpoint';

function buildBaseOAuthMetadata(params: OAuthMetadataParams): OAuthMetadata {
  return {
    issuer: params.issuerUrl.href,
    authorization_endpoint: params.authorizationUrl.href,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint: params.tokenUrl.href,
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
  };
}

function applyOptionalScopes(
  metadata: OAuthMetadata,
  requiredScopes: readonly string[]
): void {
  const scopesSupported = resolveOptionalScopes(requiredScopes);
  if (scopesSupported !== undefined) {
    metadata.scopes_supported = scopesSupported;
  }
}

function applyOptionalEndpoint(
  metadata: OAuthMetadata,
  key: OptionalEndpointKey,
  url: URL | undefined
): void {
  if (!url) return;
  metadata[key] = url.href;
}

function buildOAuthMetadata(params: OAuthMetadataParams): OAuthMetadata {
  const oauthMetadata = buildBaseOAuthMetadata(params);
  applyOptionalScopes(oauthMetadata, params.requiredScopes);
  applyOptionalEndpoint(
    oauthMetadata,
    'revocation_endpoint',
    params.revocationUrl
  );
  applyOptionalEndpoint(
    oauthMetadata,
    'registration_endpoint',
    params.registrationUrl
  );
  return oauthMetadata;
}

export function createAuthMiddleware(): RequestHandler {
  const metadataUrl = resolveMetadataUrl();
  const authHandler = requireBearerAuth({
    verifier: { verifyAccessToken },
    requiredScopes: config.auth.requiredScopes,
    ...(metadataUrl ? { resourceMetadataUrl: metadataUrl } : {}),
  });
  const legacyHandler = createLegacyApiKeyMiddleware();

  return (req: Request, res: Response, next: NextFunction): void => {
    legacyHandler(req, res, () => {
      authHandler(req, res, next);
    });
  };
}

export function createAuthMetadataRouter(): Router | null {
  if (config.auth.mode !== 'oauth') return null;

  const oauthMetadataParams = resolveOAuthMetadataParams(config.auth);
  if (!oauthMetadataParams) return null;

  return mcpAuthMetadataRouter({
    oauthMetadata: buildOAuthMetadata(oauthMetadataParams),
    resourceServerUrl: config.auth.resourceUrl,
    scopesSupported: config.auth.requiredScopes,
    resourceName: config.server.name,
  });
}
