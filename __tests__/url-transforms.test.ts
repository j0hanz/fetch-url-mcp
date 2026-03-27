import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createDefaultBlockList,
  normalizeIpForBlockList,
  RawUrlTransformer,
} from '../src/lib/url.js';
import { normalizeHost } from '../src/lib/url.js';

// ── normalizeHost ───────────────────────────────────────────────────

describe('normalizeHost', () => {
  it('normalizes a plain hostname', () => {
    assert.equal(normalizeHost('Example.COM'), 'example.com');
  });

  it('extracts hostname from host header with port', () => {
    assert.equal(normalizeHost('MyApp.io:3000'), 'myapp.io');
  });

  it('extracts first value from forwarded header', () => {
    assert.equal(normalizeHost('first.com, second.com'), 'first.com');
  });

  it('returns null for empty string', () => {
    assert.equal(normalizeHost(''), null);
  });

  it('returns null for whitespace-only', () => {
    assert.equal(normalizeHost('   '), null);
  });

  it('handles IPv6 bracket notation', () => {
    const result = normalizeHost('[::1]');
    assert.ok(result !== null, 'Should parse IPv6 brackets');
  });

  it('handles host:port format', () => {
    assert.equal(normalizeHost('example.com:8080'), 'example.com');
  });
});

// ── normalizeIpForBlockList ─────────────────────────────────────────

describe('normalizeIpForBlockList', () => {
  it('returns ipv4 family for valid IPv4', () => {
    const result = normalizeIpForBlockList('192.168.1.1');
    assert.deepEqual(result, { ip: '192.168.1.1', family: 'ipv4' });
  });

  it('returns ipv6 family for valid IPv6', () => {
    const result = normalizeIpForBlockList('::1');
    assert.ok(result !== null);
    assert.equal(result.family, 'ipv6');
  });

  it('extracts IPv4 from IPv6-mapped address', () => {
    const result = normalizeIpForBlockList('::ffff:10.0.0.1');
    assert.ok(result !== null);
    assert.equal(result.ip, '10.0.0.1');
    assert.equal(result.family, 'ipv4');
  });

  it('strips IPv6 zone ID', () => {
    const result = normalizeIpForBlockList('fe80::1%eth0');
    assert.ok(result !== null);
    assert.equal(result.family, 'ipv6');
    assert.ok(!result.ip.includes('%'), 'Zone ID must be stripped');
  });

  it('returns null for empty string', () => {
    assert.equal(normalizeIpForBlockList(''), null);
  });

  it('returns null for non-IP string', () => {
    assert.equal(normalizeIpForBlockList('not-an-ip'), null);
  });
});

// ── createDefaultBlockList ──────────────────────────────────────────

describe('createDefaultBlockList', () => {
  it('blocks private IPv4 ranges', () => {
    const list = createDefaultBlockList();
    assert.equal(list.check('10.0.0.1', 'ipv4'), true);
    assert.equal(list.check('172.16.0.1', 'ipv4'), true);
    assert.equal(list.check('192.168.1.1', 'ipv4'), true);
  });

  it('blocks loopback IPv4', () => {
    const list = createDefaultBlockList();
    assert.equal(list.check('127.0.0.1', 'ipv4'), true);
  });

  it('blocks link-local IPv4', () => {
    const list = createDefaultBlockList();
    assert.equal(list.check('169.254.1.1', 'ipv4'), true);
  });

  it('blocks IPv6 loopback', () => {
    const list = createDefaultBlockList();
    assert.equal(list.check('::1', 'ipv6'), true);
  });

  it('allows public IPv4', () => {
    const list = createDefaultBlockList();
    assert.equal(list.check('8.8.8.8', 'ipv4'), false);
  });
});

// ── RawUrlTransformer ───────────────────────────────────────────────

describe('RawUrlTransformer', () => {
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  const transformer = new RawUrlTransformer(logger);

  it('transforms GitHub blob URL to raw content URL', () => {
    const result = transformer.transformToRawUrl(
      'https://github.com/owner/repo/blob/main/README.md'
    );
    assert.equal(result.transformed, true);
    assert.equal(result.platform, 'github');
    assert.ok(result.url.includes('raw.githubusercontent.com'));
    assert.ok(result.url.includes('owner/repo/main/README.md'));
  });

  it('does not transform already-raw GitHub URL', () => {
    const result = transformer.transformToRawUrl(
      'https://raw.githubusercontent.com/owner/repo/main/file.txt'
    );
    assert.equal(result.transformed, false);
  });

  it('transforms GitLab blob URL', () => {
    const result = transformer.transformToRawUrl(
      'https://gitlab.com/group/project/-/blob/main/README.md'
    );
    assert.equal(result.transformed, true);
    assert.equal(result.platform, 'gitlab');
    assert.ok(result.url.includes('/-/raw/'));
  });

  it('transforms Bitbucket src URL', () => {
    const result = transformer.transformToRawUrl(
      'https://bitbucket.org/owner/repo/src/main/README.md'
    );
    assert.equal(result.transformed, true);
    assert.equal(result.platform, 'bitbucket');
  });

  it('does not transform non-code-host URL', () => {
    const result = transformer.transformToRawUrl(
      'https://example.com/page.html'
    );
    assert.equal(result.transformed, false);
  });

  it('returns unchanged for empty string', () => {
    const result = transformer.transformToRawUrl('');
    assert.equal(result.transformed, false);
  });

  it('recognizes raw text content URLs', () => {
    assert.equal(
      transformer.isRawTextContentUrl(
        'https://raw.githubusercontent.com/o/r/m/file.md'
      ),
      true
    );
    assert.equal(
      transformer.isRawTextContentUrl('https://example.com/doc.md'),
      true
    );
    assert.equal(
      transformer.isRawTextContentUrl('https://example.com/doc.json'),
      true
    );
    assert.equal(
      transformer.isRawTextContentUrl('https://example.com/page.html'),
      false
    );
  });
});
