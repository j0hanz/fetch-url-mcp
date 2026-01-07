import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

import { config } from '../config/index.js';

import { timingSafeEqualUtf8 } from '../utils/crypto.js';

const STATIC_TOKEN_TTL_SECONDS = 60 * 60 * 24;

function buildStaticAuthInfo(token: string): AuthInfo {
  return {
    token,
    clientId: 'static-token',
    scopes: config.auth.requiredScopes,
    expiresAt: Math.floor(Date.now() / 1000) + STATIC_TOKEN_TTL_SECONDS,
    resource: config.auth.resourceUrl,
  };
}

export function verifyStaticToken(token: string): AuthInfo {
  if (config.auth.staticTokens.length === 0) {
    throw new InvalidTokenError('No static tokens configured');
  }

  const matched = config.auth.staticTokens.some((candidate) =>
    timingSafeEqualUtf8(candidate, token)
  );
  if (!matched) {
    throw new InvalidTokenError('Invalid token');
  }

  return buildStaticAuthInfo(token);
}
