import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { transformToRawUrl } from '../dist/lib/fetch.js';

type TransformCase = {
  url: string;
  expected: string;
  platform?: string;
};

type PassThroughCase = {
  url: string;
};

function assertTransformCase(testCase: TransformCase): void {
  const result = transformToRawUrl(testCase.url);

  assert.equal(result.transformed, true);
  assert.equal(result.platform, testCase.platform);
  assert.equal(result.url, testCase.expected);
}

function assertPassThroughCase(testCase: PassThroughCase): void {
  const result = transformToRawUrl(testCase.url);

  assert.equal(result.transformed, false);
  assert.equal(result.url, testCase.url);
}

describe('url-transformer', () => {
  describe('transformToRawUrl', () => {
    describe('GitHub blob URLs', () => {
      it('transforms standard GitHub blob URL', () => {
        assertTransformCase({
          url: 'https://github.com/dfinke/awesome-copilot-chatmodes/blob/main/chatmodes/bullet-points.chatmode.md',
          expected:
            'https://raw.githubusercontent.com/dfinke/awesome-copilot-chatmodes/main/chatmodes/bullet-points.chatmode.md',
          platform: 'github',
        });
      });

      it('transforms GitHub blob URL with different branch', () => {
        assertTransformCase({
          url: 'https://github.com/owner/repo/blob/develop/src/index.ts',
          expected:
            'https://raw.githubusercontent.com/owner/repo/develop/src/index.ts',
          platform: 'github',
        });
      });

      it('transforms GitHub blob URL with commit SHA', () => {
        assertTransformCase({
          url: 'https://github.com/owner/repo/blob/abc123def456/README.md',
          expected:
            'https://raw.githubusercontent.com/owner/repo/abc123def456/README.md',
          platform: 'github',
        });
      });

      it('transforms GitHub blob URL with www prefix', () => {
        assertTransformCase({
          url: 'https://www.github.com/owner/repo/blob/main/file.js',
          expected: 'https://raw.githubusercontent.com/owner/repo/main/file.js',
          platform: 'github',
        });
      });

      it('transforms GitHub blob URL with nested path', () => {
        assertTransformCase({
          url: 'https://github.com/owner/repo/blob/main/src/deep/nested/path/file.ts',
          expected:
            'https://raw.githubusercontent.com/owner/repo/main/src/deep/nested/path/file.ts',
          platform: 'github',
        });
      });

      it('handles GitHub blob URL with query string', () => {
        assertTransformCase({
          url: 'https://github.com/owner/repo/blob/main/file.js?raw=true',
          expected: 'https://raw.githubusercontent.com/owner/repo/main/file.js',
          platform: 'github',
        });
      });
    });

    describe('GitHub Gist URLs', () => {
      it('transforms basic Gist URL', () => {
        assertTransformCase({
          url: 'https://gist.github.com/user/abc123def456789',
          expected:
            'https://gist.githubusercontent.com/user/abc123def456789/raw',
          platform: 'github-gist',
        });
      });

      it('transforms Gist URL with file hash', () => {
        assertTransformCase({
          url: 'https://gist.github.com/user/abc123def456789#file-example-js',
          expected:
            'https://gist.githubusercontent.com/user/abc123def456789/raw/example.js',
          platform: 'github-gist',
        });
      });
    });

    describe('GitLab blob URLs', () => {
      it('transforms standard GitLab blob URL', () => {
        assertTransformCase({
          url: 'https://gitlab.com/owner/project/-/blob/main/src/index.ts',
          expected: 'https://gitlab.com/owner/project/-/raw/main/src/index.ts',
          platform: 'gitlab',
        });
      });

      it('transforms GitLab blob URL with subdomain', () => {
        assertTransformCase({
          url: 'https://code.gitlab.com/owner/project/-/blob/develop/README.md',
          expected:
            'https://code.gitlab.com/owner/project/-/raw/develop/README.md',
          platform: 'gitlab',
        });
      });
    });

    describe('Bitbucket src URLs', () => {
      it('transforms standard Bitbucket src URL', () => {
        assertTransformCase({
          url: 'https://bitbucket.org/owner/repo/src/main/package.json',
          expected: 'https://bitbucket.org/owner/repo/raw/main/package.json',
          platform: 'bitbucket',
        });
      });

      it('transforms Bitbucket src URL with www', () => {
        assertTransformCase({
          url: 'https://www.bitbucket.org/owner/repo/src/develop/src/app.ts',
          expected:
            'https://www.bitbucket.org/owner/repo/raw/develop/src/app.ts',
          platform: 'bitbucket',
        });
      });
    });

    describe('Already raw URLs (no transformation)', () => {
      it('skips raw.githubusercontent.com URLs', () => {
        assertPassThroughCase({
          url: 'https://raw.githubusercontent.com/owner/repo/main/file.js',
        });
      });

      it('skips gist.githubusercontent.com URLs', () => {
        assertPassThroughCase({
          url: 'https://gist.githubusercontent.com/user/abc123/raw/file.js',
        });
      });

      it('skips GitLab raw URLs', () => {
        assertPassThroughCase({
          url: 'https://gitlab.com/owner/project/-/raw/main/file.ts',
        });
      });

      it('skips Bitbucket raw URLs', () => {
        assertPassThroughCase({
          url: 'https://bitbucket.org/owner/repo/raw/main/file.ts',
        });
      });
    });

    describe('Non-matching URLs (no transformation)', () => {
      it('passes through regular URLs unchanged', () => {
        assertPassThroughCase({ url: 'https://example.com/page.html' });
      });

      it('passes through GitHub non-blob URLs unchanged', () => {
        assertPassThroughCase({ url: 'https://github.com/owner/repo' });
      });

      it('passes through GitHub issues URLs unchanged', () => {
        assertPassThroughCase({
          url: 'https://github.com/owner/repo/issues/123',
        });
      });

      it('handles empty string', () => {
        assertPassThroughCase({ url: '' });
      });
    });

    it('handles non-string input gracefully', () => {
      const callTransformToRawUrl = transformToRawUrl as (
        url: unknown
      ) => ReturnType<typeof transformToRawUrl>;
      const result = callTransformToRawUrl(null);
      assert.equal(result.transformed, false);
    });
  });
});
