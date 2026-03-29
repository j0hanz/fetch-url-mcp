import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { config, serverVersion } from '../src/lib/config.js';

// ── Golden Master: config shape & default values ────────────────────
// Locks the exported config structure so refactors cannot silently
// change observable behavior.

describe('config shape', () => {
  it('exports a non-empty serverVersion string', () => {
    assert.equal(typeof serverVersion, 'string');
    assert.ok(serverVersion.length > 0, 'serverVersion must not be empty');
  });

  it('does not re-export config values from lib/core', async () => {
    const coreModule = await import('../src/lib/core.js');

    assert.equal('config' in coreModule, false);
    assert.equal('serverVersion' in coreModule, false);
    assert.equal('enableHttpMode' in coreModule, false);
  });

  it('has all top-level sections', () => {
    const expected = [
      'server',
      'fetcher',
      'transform',
      'tools',
      'tasks',
      'extraction',
      'noiseRemoval',
      'markdownCleanup',
      'i18n',
      'logging',
      'constants',
      'security',
      'auth',
      'rateLimit',
      'runtime',
    ];
    assert.deepStrictEqual(Object.keys(config).sort(), expected.sort());
  });

  it('server section has required keys', () => {
    const keys = Object.keys(config.server);
    for (const k of ['name', 'version', 'port', 'host', 'https', 'http']) {
      assert.ok(keys.includes(k), `server.${k} missing`);
    }
    assert.equal(config.server.name, 'fetch-url-mcp');
    assert.equal(typeof config.server.port, 'number');
  });

  it('fetcher section has required keys', () => {
    const { fetcher } = config;
    assert.equal(typeof fetcher.timeout, 'number');
    assert.equal(typeof fetcher.maxRedirects, 'number');
    assert.equal(typeof fetcher.userAgent, 'string');
    assert.equal(typeof fetcher.maxContentLength, 'number');
  });

  it('transform section has required keys', () => {
    const { transform } = config;
    assert.equal(typeof transform.timeoutMs, 'number');
    assert.equal(typeof transform.stageWarnRatio, 'number');
    assert.equal(typeof transform.maxWorkerScale, 'number');
    assert.equal(typeof transform.cancelAckTimeoutMs, 'number');
    assert.ok(
      transform.workerMode === 'threads' || transform.workerMode === 'process'
    );
  });

  it('tasks section has required keys', () => {
    const { tasks } = config;
    assert.equal(typeof tasks.maxTotal, 'number');
    assert.equal(typeof tasks.maxPerOwner, 'number');
    assert.equal(typeof tasks.emitStatusNotifications, 'boolean');
    assert.equal(typeof tasks.requireInterception, 'boolean');
  });

  it('constants section has required keys', () => {
    const { constants } = config;
    assert.equal(typeof constants.maxHtmlBytes, 'number');
    assert.equal(typeof constants.maxUrlLength, 'number');
    assert.equal(typeof constants.maxInlineContentChars, 'number');
  });

  it('security section has required keys', () => {
    const { security } = config;
    assert.ok(security.blockedHosts instanceof Set);
    assert.ok(security.allowedHosts instanceof Set);
    assert.equal(typeof security.allowRemote, 'boolean');
    assert.equal(typeof security.allowLocalFetch, 'boolean');
  });

  it('auth section has required keys', () => {
    const { auth } = config;
    assert.ok(auth.mode === 'oauth' || auth.mode === 'static');
    assert.ok(auth.resourceUrl instanceof URL);
    assert.ok(Array.isArray(auth.requiredScopes));
    assert.ok(Array.isArray(auth.staticTokens));
  });

  it('noiseRemoval section has required keys', () => {
    const { noiseRemoval } = config;
    assert.ok(Array.isArray(noiseRemoval.extraTokens));
    assert.ok(Array.isArray(noiseRemoval.extraSelectors));
    assert.ok(Array.isArray(noiseRemoval.enabledCategories));
    assert.equal(typeof noiseRemoval.debug, 'boolean');
    assert.equal(typeof noiseRemoval.aggressiveMode, 'boolean');
    assert.equal(typeof noiseRemoval.preserveSvgCanvas, 'boolean');
    assert.equal(typeof noiseRemoval.weights.threshold, 'number');
  });

  it('markdownCleanup section has required keys', () => {
    const { markdownCleanup } = config;
    assert.equal(typeof markdownCleanup.promoteOrphanHeadings, 'boolean');
    assert.equal(typeof markdownCleanup.removeSkipLinks, 'boolean');
    assert.ok(Array.isArray(markdownCleanup.headingKeywords));
    assert.ok(markdownCleanup.headingKeywords.length > 0);
  });

  it('runtime section tracks httpMode', () => {
    assert.equal(typeof config.runtime.httpMode, 'boolean');
  });

  it('rateLimit section has required keys', () => {
    const { rateLimit } = config;
    assert.equal(typeof rateLimit.enabled, 'boolean');
    assert.equal(typeof rateLimit.maxRequests, 'number');
    assert.equal(typeof rateLimit.windowMs, 'number');
  });
});
