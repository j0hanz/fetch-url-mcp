import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, it } from 'node:test';

import { authService } from '../src/http/index.js';
import { config } from '../src/lib/config.js';

interface OAuthConfigSnapshot {
  mode: typeof config.auth.mode;
  introspectionUrl: typeof config.auth.introspectionUrl;
  resourceUrl: URL;
  clientId: typeof config.auth.clientId;
  clientSecret: typeof config.auth.clientSecret;
  requiredScopes: string[];
}

function createBearerRequest(token: string): IncomingMessage {
  return {
    headers: {
      authorization: `Bearer ${token}`,
    },
  } as IncomingMessage;
}

function snapshotOAuthConfig(): OAuthConfigSnapshot {
  return {
    mode: config.auth.mode,
    introspectionUrl: config.auth.introspectionUrl,
    resourceUrl: new URL(config.auth.resourceUrl),
    clientId: config.auth.clientId,
    clientSecret: config.auth.clientSecret,
    requiredScopes: [...config.auth.requiredScopes],
  };
}

function restoreOAuthConfig(snapshot: OAuthConfigSnapshot): void {
  config.auth.mode = snapshot.mode;
  config.auth.introspectionUrl = snapshot.introspectionUrl;
  config.auth.resourceUrl = snapshot.resourceUrl;
  config.auth.clientId = snapshot.clientId;
  config.auth.clientSecret = snapshot.clientSecret;
  config.auth.requiredScopes.splice(
    0,
    config.auth.requiredScopes.length,
    ...snapshot.requiredScopes
  );
}

function mockJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('OAuth auth handling', () => {
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  const originalConfig = snapshotOAuthConfig();

  afterEach(() => {
    Object.defineProperty(globalThis, 'fetch', {
      value: originalFetch,
      configurable: true,
      writable: true,
    });
    Date.now = originalDateNow;
    restoreOAuthConfig(originalConfig);
  });

  it('encodes introspection client credentials as UTF-8 basic auth', async () => {
    config.auth.mode = 'oauth';
    config.auth.introspectionUrl = new URL(
      'https://issuer.example.com/introspect'
    );
    config.auth.resourceUrl = new URL('https://resource.example.com/mcp');
    config.auth.clientId = 'clïent';
    config.auth.clientSecret = 'påss';

    let capturedAuthorizationHeader: string | undefined;
    Object.defineProperty(globalThis, 'fetch', {
      value: async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string> | undefined;
        capturedAuthorizationHeader = headers?.['authorization'];

        return mockJsonResponse({
          active: true,
          aud: config.auth.resourceUrl.href,
          exp: Math.floor(Date.now() / 1000) + 60,
          client_id: 'oauth-client',
          scope: '',
        });
      },
      configurable: true,
      writable: true,
    });

    await authService.authenticate(
      createBearerRequest('utf8-basic-auth-token')
    );

    assert.equal(
      capturedAuthorizationHeader,
      `Basic ${Buffer.from('clïent:påss', 'utf8').toString('base64')}`
    );
  });

  it('does not reuse introspection cache entries after token expiry', async () => {
    let now = 1_760_000_000_000;
    Date.now = () => now;

    config.auth.mode = 'oauth';
    config.auth.introspectionUrl = new URL(
      'https://issuer.example.com/introspect'
    );
    config.auth.resourceUrl = new URL('https://resource.example.com/mcp');
    config.auth.clientId = undefined;
    config.auth.clientSecret = undefined;
    config.auth.requiredScopes.splice(0, config.auth.requiredScopes.length);

    let fetchCount = 0;
    Object.defineProperty(globalThis, 'fetch', {
      value: async () => {
        fetchCount += 1;

        return fetchCount === 1
          ? mockJsonResponse({
              active: true,
              aud: config.auth.resourceUrl.href,
              exp: Math.floor((now + 1_000) / 1000),
              client_id: 'oauth-client',
              scope: '',
            })
          : mockJsonResponse({ active: false });
      },
      configurable: true,
      writable: true,
    });

    const request = createBearerRequest('short-lived-token');
    const firstInfo = await authService.authenticate(request);
    assert.equal(firstInfo.clientId, 'oauth-client');

    now += 2_000;

    await assert.rejects(
      () => authService.authenticate(request),
      /Token is inactive/
    );
    assert.equal(fetchCount, 2);
  });

  it('preserves stable subject claims from introspection in authInfo.extra', async () => {
    config.auth.mode = 'oauth';
    config.auth.introspectionUrl = new URL(
      'https://issuer.example.com/introspect'
    );
    config.auth.resourceUrl = new URL('https://resource.example.com/mcp');
    config.auth.clientId = undefined;
    config.auth.clientSecret = undefined;
    config.auth.requiredScopes.splice(0, config.auth.requiredScopes.length);

    Object.defineProperty(globalThis, 'fetch', {
      value: async () =>
        mockJsonResponse({
          active: true,
          aud: config.auth.resourceUrl.href,
          exp: Math.floor(Date.now() / 1000) + 60,
          client_id: 'oauth-client',
          scope: '',
          sub: 'user-123',
          subject: 'user-123',
        }),
      configurable: true,
      writable: true,
    });

    const info = await authService.authenticate(
      createBearerRequest('stable-subject-token')
    );

    assert.deepEqual(info.extra, {
      sub: 'user-123',
      subject: 'user-123',
    });
  });
});
