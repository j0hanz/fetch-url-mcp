import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { transformToRawUrl } from '../dist/utils/url-transformer.js';

type TransformCase = {
  name: string;
  url: string;
  expected: string;
  platform?: string;
};

type PassThroughCase = {
  name: string;
  url: string;
};

const GITHUB_BLOB_CASES: readonly TransformCase[] = [
  {
    name: 'transforms standard GitHub blob URL',
    url: 'https://github.com/dfinke/awesome-copilot-chatmodes/blob/main/chatmodes/bullet-points.chatmode.md',
    expected:
      'https://raw.githubusercontent.com/dfinke/awesome-copilot-chatmodes/main/chatmodes/bullet-points.chatmode.md',
    platform: 'github',
  },
  {
    name: 'transforms GitHub blob URL with different branch',
    url: 'https://github.com/owner/repo/blob/develop/src/index.ts',
    expected:
      'https://raw.githubusercontent.com/owner/repo/develop/src/index.ts',
    platform: 'github',
  },
  {
    name: 'transforms GitHub blob URL with commit SHA',
    url: 'https://github.com/owner/repo/blob/abc123def456/README.md',
    expected:
      'https://raw.githubusercontent.com/owner/repo/abc123def456/README.md',
    platform: 'github',
  },
  {
    name: 'transforms GitHub blob URL with www prefix',
    url: 'https://www.github.com/owner/repo/blob/main/file.js',
    expected: 'https://raw.githubusercontent.com/owner/repo/main/file.js',
    platform: 'github',
  },
  {
    name: 'transforms GitHub blob URL with nested path',
    url: 'https://github.com/owner/repo/blob/main/src/deep/nested/path/file.ts',
    expected:
      'https://raw.githubusercontent.com/owner/repo/main/src/deep/nested/path/file.ts',
    platform: 'github',
  },
  {
    name: 'handles GitHub blob URL with query string',
    url: 'https://github.com/owner/repo/blob/main/file.js?raw=true',
    expected: 'https://raw.githubusercontent.com/owner/repo/main/file.js',
    platform: 'github',
  },
];

const GITHUB_GIST_CASES: readonly TransformCase[] = [
  {
    name: 'transforms basic Gist URL',
    url: 'https://gist.github.com/user/abc123def456789',
    expected: 'https://gist.githubusercontent.com/user/abc123def456789/raw',
    platform: 'github-gist',
  },
  {
    name: 'transforms Gist URL with file hash',
    url: 'https://gist.github.com/user/abc123def456789#file-example-js',
    expected:
      'https://gist.githubusercontent.com/user/abc123def456789/raw/example.js',
    platform: 'github-gist',
  },
];

const GITLAB_BLOB_CASES: readonly TransformCase[] = [
  {
    name: 'transforms standard GitLab blob URL',
    url: 'https://gitlab.com/owner/project/-/blob/main/src/index.ts',
    expected: 'https://gitlab.com/owner/project/-/raw/main/src/index.ts',
    platform: 'gitlab',
  },
  {
    name: 'transforms GitLab blob URL with subdomain',
    url: 'https://code.gitlab.com/owner/project/-/blob/develop/README.md',
    expected: 'https://code.gitlab.com/owner/project/-/raw/develop/README.md',
    platform: 'gitlab',
  },
];

const BITBUCKET_SRC_CASES: readonly TransformCase[] = [
  {
    name: 'transforms standard Bitbucket src URL',
    url: 'https://bitbucket.org/owner/repo/src/main/package.json',
    expected: 'https://bitbucket.org/owner/repo/raw/main/package.json',
    platform: 'bitbucket',
  },
  {
    name: 'transforms Bitbucket src URL with www',
    url: 'https://www.bitbucket.org/owner/repo/src/develop/src/app.ts',
    expected: 'https://www.bitbucket.org/owner/repo/raw/develop/src/app.ts',
    platform: 'bitbucket',
  },
];

const RAW_URL_CASES: readonly PassThroughCase[] = [
  {
    name: 'skips raw.githubusercontent.com URLs',
    url: 'https://raw.githubusercontent.com/owner/repo/main/file.js',
  },
  {
    name: 'skips gist.githubusercontent.com URLs',
    url: 'https://gist.githubusercontent.com/user/abc123/raw/file.js',
  },
  {
    name: 'skips GitLab raw URLs',
    url: 'https://gitlab.com/owner/project/-/raw/main/file.ts',
  },
  {
    name: 'skips Bitbucket raw URLs',
    url: 'https://bitbucket.org/owner/repo/raw/main/file.ts',
  },
];

const NON_MATCHING_CASES: readonly PassThroughCase[] = [
  {
    name: 'passes through regular URLs unchanged',
    url: 'https://example.com/page.html',
  },
  {
    name: 'passes through GitHub non-blob URLs unchanged',
    url: 'https://github.com/owner/repo',
  },
  {
    name: 'passes through GitHub issues URLs unchanged',
    url: 'https://github.com/owner/repo/issues/123',
  },
  {
    name: 'handles empty string',
    url: '',
  },
];

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

function registerTransformCases(
  title: string,
  cases: readonly TransformCase[]
): void {
  describe(title, () => {
    cases.forEach((testCase) => {
      it(testCase.name, () => {
        assertTransformCase(testCase);
      });
    });
  });
}

function registerPassThroughCases(
  title: string,
  cases: readonly PassThroughCase[]
): void {
  describe(title, () => {
    cases.forEach((testCase) => {
      it(testCase.name, () => {
        assertPassThroughCase(testCase);
      });
    });
  });
}

function registerTransformToRawUrlTests(): void {
  describe('transformToRawUrl', () => {
    registerTransformCases('GitHub blob URLs', GITHUB_BLOB_CASES);
    registerTransformCases('GitHub Gist URLs', GITHUB_GIST_CASES);
    registerTransformCases('GitLab blob URLs', GITLAB_BLOB_CASES);
    registerTransformCases('Bitbucket src URLs', BITBUCKET_SRC_CASES);
    registerPassThroughCases(
      'Already raw URLs (no transformation)',
      RAW_URL_CASES
    );
    registerPassThroughCases(
      'Non-matching URLs (no transformation)',
      NON_MATCHING_CASES
    );

    it('handles non-string input gracefully', () => {
      // @ts-expect-error - Testing invalid input
      const result = transformToRawUrl(null);
      assert.equal(result.transformed, false);
    });
  });
}

describe('url-transformer', () => {
  registerTransformToRawUrlTests();
});
