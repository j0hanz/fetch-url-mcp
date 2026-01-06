import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isTransformableUrl,
  transformToRawUrl,
} from '../dist/utils/url-transformer.js';

describe('url-transformer', () => {
  describe('transformToRawUrl', () => {
    describe('GitHub blob URLs', () => {
      it('transforms standard GitHub blob URL', () => {
        const url =
          'https://github.com/dfinke/awesome-copilot-chatmodes/blob/main/chatmodes/bullet-points.chatmode.md';
        const result = transformToRawUrl(url);

        assert.equal(result.transformed, true);
        assert.equal(result.platform, 'github');
        assert.equal(
          result.url,
          'https://raw.githubusercontent.com/dfinke/awesome-copilot-chatmodes/main/chatmodes/bullet-points.chatmode.md'
        );
      });

      it('transforms GitHub blob URL with different branch', () => {
        const url = 'https://github.com/owner/repo/blob/develop/src/index.ts';
        const result = transformToRawUrl(url);

        assert.equal(result.transformed, true);
        assert.equal(
          result.url,
          'https://raw.githubusercontent.com/owner/repo/develop/src/index.ts'
        );
      });

      it('transforms GitHub blob URL with commit SHA', () => {
        const url = 'https://github.com/owner/repo/blob/abc123def456/README.md';
        const result = transformToRawUrl(url);

        assert.equal(result.transformed, true);
        assert.equal(
          result.url,
          'https://raw.githubusercontent.com/owner/repo/abc123def456/README.md'
        );
      });

      it('transforms GitHub blob URL with www prefix', () => {
        const url = 'https://www.github.com/owner/repo/blob/main/file.js';
        const result = transformToRawUrl(url);

        assert.equal(result.transformed, true);
        assert.equal(
          result.url,
          'https://raw.githubusercontent.com/owner/repo/main/file.js'
        );
      });

      it('transforms GitHub blob URL with nested path', () => {
        const url =
          'https://github.com/owner/repo/blob/main/src/deep/nested/path/file.ts';
        const result = transformToRawUrl(url);

        assert.equal(result.transformed, true);
        assert.equal(
          result.url,
          'https://raw.githubusercontent.com/owner/repo/main/src/deep/nested/path/file.ts'
        );
      });

      it('handles GitHub blob URL with query string', () => {
        const url = 'https://github.com/owner/repo/blob/main/file.js?raw=true';
        const result = transformToRawUrl(url);

        assert.equal(result.transformed, true);
        assert.equal(
          result.url,
          'https://raw.githubusercontent.com/owner/repo/main/file.js'
        );
      });
    });

    describe('GitHub Gist URLs', () => {
      it('transforms basic Gist URL', () => {
        const url = 'https://gist.github.com/user/abc123def456789';
        const result = transformToRawUrl(url);

        assert.equal(result.transformed, true);
        assert.equal(result.platform, 'github-gist');
        assert.equal(
          result.url,
          'https://gist.githubusercontent.com/user/abc123def456789/raw'
        );
      });

      it('transforms Gist URL with file hash', () => {
        const url =
          'https://gist.github.com/user/abc123def456789#file-example-js';
        const result = transformToRawUrl(url);

        assert.equal(result.transformed, true);
        assert.equal(
          result.url,
          'https://gist.githubusercontent.com/user/abc123def456789/raw/example.js'
        );
      });
    });

    describe('GitLab blob URLs', () => {
      it('transforms standard GitLab blob URL', () => {
        const url = 'https://gitlab.com/owner/project/-/blob/main/src/index.ts';
        const result = transformToRawUrl(url);

        assert.equal(result.transformed, true);
        assert.equal(result.platform, 'gitlab');
        assert.equal(
          result.url,
          'https://gitlab.com/owner/project/-/raw/main/src/index.ts'
        );
      });

      it('transforms GitLab blob URL with subdomain', () => {
        const url =
          'https://code.gitlab.com/owner/project/-/blob/develop/README.md';
        const result = transformToRawUrl(url);

        assert.equal(result.transformed, true);
        assert.equal(
          result.url,
          'https://code.gitlab.com/owner/project/-/raw/develop/README.md'
        );
      });
    });

    describe('Bitbucket src URLs', () => {
      it('transforms standard Bitbucket src URL', () => {
        const url = 'https://bitbucket.org/owner/repo/src/main/package.json';
        const result = transformToRawUrl(url);

        assert.equal(result.transformed, true);
        assert.equal(result.platform, 'bitbucket');
        assert.equal(
          result.url,
          'https://bitbucket.org/owner/repo/raw/main/package.json'
        );
      });

      it('transforms Bitbucket src URL with www', () => {
        const url =
          'https://www.bitbucket.org/owner/repo/src/develop/src/app.ts';
        const result = transformToRawUrl(url);

        assert.equal(result.transformed, true);
        assert.equal(
          result.url,
          'https://www.bitbucket.org/owner/repo/raw/develop/src/app.ts'
        );
      });
    });

    describe('Already raw URLs (no transformation)', () => {
      it('skips raw.githubusercontent.com URLs', () => {
        const url = 'https://raw.githubusercontent.com/owner/repo/main/file.js';
        const result = transformToRawUrl(url);

        assert.equal(result.transformed, false);
        assert.equal(result.url, url);
      });

      it('skips gist.githubusercontent.com URLs', () => {
        const url =
          'https://gist.githubusercontent.com/user/abc123/raw/file.js';
        const result = transformToRawUrl(url);

        assert.equal(result.transformed, false);
        assert.equal(result.url, url);
      });

      it('skips GitLab raw URLs', () => {
        const url = 'https://gitlab.com/owner/project/-/raw/main/file.ts';
        const result = transformToRawUrl(url);

        assert.equal(result.transformed, false);
        assert.equal(result.url, url);
      });

      it('skips Bitbucket raw URLs', () => {
        const url = 'https://bitbucket.org/owner/repo/raw/main/file.ts';
        const result = transformToRawUrl(url);

        assert.equal(result.transformed, false);
        assert.equal(result.url, url);
      });
    });

    describe('Non-matching URLs (no transformation)', () => {
      it('passes through regular URLs unchanged', () => {
        const url = 'https://example.com/page.html';
        const result = transformToRawUrl(url);

        assert.equal(result.transformed, false);
        assert.equal(result.url, url);
      });

      it('passes through GitHub non-blob URLs unchanged', () => {
        const url = 'https://github.com/owner/repo';
        const result = transformToRawUrl(url);

        assert.equal(result.transformed, false);
        assert.equal(result.url, url);
      });

      it('passes through GitHub issues URLs unchanged', () => {
        const url = 'https://github.com/owner/repo/issues/123';
        const result = transformToRawUrl(url);

        assert.equal(result.transformed, false);
        assert.equal(result.url, url);
      });

      it('handles empty string', () => {
        const result = transformToRawUrl('');

        assert.equal(result.transformed, false);
        assert.equal(result.url, '');
      });

      it('handles non-string input gracefully', () => {
        // @ts-expect-error - Testing invalid input
        const result = transformToRawUrl(null);

        assert.equal(result.transformed, false);
      });
    });
  });

  describe('isTransformableUrl', () => {
    it('returns true for GitHub blob URLs', () => {
      const url = 'https://github.com/owner/repo/blob/main/file.js';
      assert.equal(isTransformableUrl(url), true);
    });

    it('returns true for GitLab blob URLs', () => {
      const url = 'https://gitlab.com/owner/repo/-/blob/main/file.ts';
      assert.equal(isTransformableUrl(url), true);
    });

    it('returns true for Bitbucket src URLs', () => {
      const url = 'https://bitbucket.org/owner/repo/src/main/file.py';
      assert.equal(isTransformableUrl(url), true);
    });

    it('returns false for already raw URLs', () => {
      const url = 'https://raw.githubusercontent.com/owner/repo/main/file.js';
      assert.equal(isTransformableUrl(url), false);
    });

    it('returns false for regular URLs', () => {
      const url = 'https://example.com/page.html';
      assert.equal(isTransformableUrl(url), false);
    });

    it('returns false for empty string', () => {
      assert.equal(isTransformableUrl(''), false);
    });
  });
});
