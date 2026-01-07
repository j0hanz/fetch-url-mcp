import { parseInteger, parseList, parseUrlEnv } from './env-parsers.js';

export interface CoreOAuthUrls {
  issuerUrl: URL | undefined;
  authorizationUrl: URL | undefined;
  tokenUrl: URL | undefined;
}

export interface OptionalOAuthUrls {
  revocationUrl: URL | undefined;
  registrationUrl: URL | undefined;
  introspectionUrl: URL | undefined;
  resourceUrl: URL;
}

export type AuthUrls = CoreOAuthUrls & OptionalOAuthUrls;

export type AuthConfig = AuthUrls & {
  mode: 'oauth' | 'static';
  requiredScopes: string[];
  clientId: string | undefined;
  clientSecret: string | undefined;
  introspectionTimeoutMs: number;
  staticTokens: string[];
};

function readCoreOAuthUrls(): CoreOAuthUrls {
  return {
    issuerUrl: parseUrlEnv(process.env.OAUTH_ISSUER_URL, 'OAUTH_ISSUER_URL'),
    authorizationUrl: parseUrlEnv(
      process.env.OAUTH_AUTHORIZATION_URL,
      'OAUTH_AUTHORIZATION_URL'
    ),
    tokenUrl: parseUrlEnv(process.env.OAUTH_TOKEN_URL, 'OAUTH_TOKEN_URL'),
  };
}

function readOptionalOAuthUrls(baseUrl: URL): OptionalOAuthUrls {
  return {
    revocationUrl: parseUrlEnv(
      process.env.OAUTH_REVOCATION_URL,
      'OAUTH_REVOCATION_URL'
    ),
    registrationUrl: parseUrlEnv(
      process.env.OAUTH_REGISTRATION_URL,
      'OAUTH_REGISTRATION_URL'
    ),
    introspectionUrl: parseUrlEnv(
      process.env.OAUTH_INTROSPECTION_URL,
      'OAUTH_INTROSPECTION_URL'
    ),
    resourceUrl:
      parseUrlEnv(process.env.OAUTH_RESOURCE_URL, 'OAUTH_RESOURCE_URL') ??
      new URL('/mcp', baseUrl),
  };
}

function readOAuthUrls(baseUrl: URL): AuthUrls {
  return { ...readCoreOAuthUrls(), ...readOptionalOAuthUrls(baseUrl) };
}

function resolveAuthMode(
  authModeEnv: string | undefined,
  urls: AuthUrls
): 'oauth' | 'static' {
  if (authModeEnv === 'oauth') return 'oauth';
  if (authModeEnv === 'static') return 'static';

  const oauthConfigured = [
    urls.issuerUrl,
    urls.authorizationUrl,
    urls.tokenUrl,
    urls.introspectionUrl,
  ].some((value) => value !== undefined);
  return oauthConfigured ? 'oauth' : 'static';
}

function collectStaticTokens(): string[] {
  const staticTokens = new Set<string>(parseList(process.env.ACCESS_TOKENS));
  if (process.env.API_KEY) {
    staticTokens.add(process.env.API_KEY);
  }
  return Array.from(staticTokens);
}

export function buildAuthConfig(baseUrl: URL): AuthConfig {
  const urls = readOAuthUrls(baseUrl);
  const mode = resolveAuthMode(process.env.AUTH_MODE?.toLowerCase(), urls);

  return {
    mode,
    ...urls,
    requiredScopes: parseList(process.env.OAUTH_REQUIRED_SCOPES),
    clientId: process.env.OAUTH_CLIENT_ID,
    clientSecret: process.env.OAUTH_CLIENT_SECRET,
    introspectionTimeoutMs: parseInteger(
      process.env.OAUTH_INTROSPECTION_TIMEOUT_MS,
      5000,
      1000,
      30000
    ),
    staticTokens: collectStaticTokens(),
  };
}
