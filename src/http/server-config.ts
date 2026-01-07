import { config } from '../config/index.js';

import { logError } from '../services/logger.js';

export function assertHttpConfiguration(): void {
  ensureBindAllowed();
  ensureStaticTokens();
  if (config.auth.mode === 'oauth') {
    ensureOauthConfiguration();
  }
}

function ensureBindAllowed(): void {
  const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(
    config.server.host
  );
  if (!config.security.allowRemote && !isLoopback) {
    logError(
      'Refusing to bind to non-loopback host without ALLOW_REMOTE=true',
      { host: config.server.host }
    );
    process.exit(1);
  }

  if (config.security.allowRemote && config.auth.mode !== 'oauth') {
    logError(
      'Remote HTTP mode requires OAuth configuration; refusing to start'
    );
    process.exit(1);
  }
}

function ensureStaticTokens(): void {
  if (config.auth.mode === 'static' && config.auth.staticTokens.length === 0) {
    logError('At least one static access token is required for HTTP mode');
    process.exit(1);
  }
}

function ensureOauthConfiguration(): void {
  if (!config.auth.issuerUrl || !config.auth.authorizationUrl) {
    logError(
      'OAUTH_ISSUER_URL and OAUTH_AUTHORIZATION_URL are required for OAuth mode'
    );
    process.exit(1);
  }

  if (!config.auth.tokenUrl) {
    logError('OAUTH_TOKEN_URL is required for OAuth mode');
    process.exit(1);
  }

  if (!config.auth.introspectionUrl) {
    logError('OAUTH_INTROSPECTION_URL is required for OAuth mode');
    process.exit(1);
  }
}
