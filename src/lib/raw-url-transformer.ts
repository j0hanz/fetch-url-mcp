import type { Logger } from './url-security.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TransformResult {
  readonly url: string;
  readonly transformed: boolean;
  readonly platform?: string;
}

// ---------------------------------------------------------------------------
// URL pattern helpers
// ---------------------------------------------------------------------------

type UrlPatternGroups = Record<string, string | undefined>;

export function getPatternGroup(
  groups: UrlPatternGroups,
  key: string
): string | null {
  const value = groups[key];
  if (value === undefined) return null;
  if (value === '') return null;
  return value;
}

// ---------------------------------------------------------------------------
// Platform URL patterns
// ---------------------------------------------------------------------------

const GITHUB_BLOB_PATTERN = new URLPattern({
  protocol: 'http{s}?',
  hostname: '{:sub.}?github.com',
  pathname: '/:owner/:repo/blob/:branch/:path+',
});

const GITHUB_GIST_PATTERN = new URLPattern({
  protocol: 'http{s}?',
  hostname: 'gist.github.com',
  pathname: '/:user/:gistId',
});

const GITHUB_GIST_RAW_PATTERN = new URLPattern({
  protocol: 'http{s}?',
  hostname: 'gist.github.com',
  pathname: '/:user/:gistId/raw/:filePath+',
});

const GITLAB_BLOB_PATTERNS: readonly URLPattern[] = [
  new URLPattern({
    protocol: 'http{s}?',
    hostname: 'gitlab.com',
    pathname: '/:base+/-/blob/:branch/:path+',
  }),
  new URLPattern({
    protocol: 'http{s}?',
    hostname: '*:sub.gitlab.com',
    pathname: '/:base+/-/blob/:branch/:path+',
  }),
];

const BITBUCKET_SRC_PATTERN = new URLPattern({
  protocol: 'http{s}?',
  hostname: '{:sub.}?bitbucket.org',
  pathname: '/:owner/:repo/src/:branch/:path+',
});

const BITBUCKET_RAW_RE = /bitbucket\.org\/[^/]+\/[^/]+\/raw\//;

const RAW_TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.csv',
  '.rst',
  '.adoc',
  '.org',
]);

// ---------------------------------------------------------------------------
// RawUrlTransformer
// ---------------------------------------------------------------------------

export class RawUrlTransformer {
  constructor(private readonly logger: Logger) {}

  transformToRawUrl(url: string): TransformResult {
    if (!url) return { url, transformed: false };
    if (this.isRawUrl(url)) return { url, transformed: false };
    let base: string;
    let hash: string;
    let parsed: URL | undefined;

    try {
      parsed = new URL(url);
      base = parsed.origin + parsed.pathname;
      ({ hash } = parsed);
    } catch {
      ({ base, hash } = this.splitParams(url));
    }

    const match = this.tryTransformWithUrl(base, hash, parsed);
    if (!match) return { url, transformed: false };

    this.logger.debug('URL transformed to raw content URL', {
      platform: match.platform,
      original: url.substring(0, 100),
      transformed: match.url.substring(0, 100),
    });

    return { url: match.url, transformed: true, platform: match.platform };
  }

  isRawTextContentUrl(urlString: string): boolean {
    if (!urlString) return false;
    if (this.isRawUrl(urlString)) return true;

    try {
      const url = new URL(urlString);
      const pathname = url.pathname.toLowerCase();
      const lastDot = pathname.lastIndexOf('.');
      if (lastDot === -1) return false;

      return RAW_TEXT_EXTENSIONS.has(pathname.slice(lastDot));
    } catch {
      const { base } = this.splitParams(urlString);
      const lowerBase = base.toLowerCase();
      const lastDot = lowerBase.lastIndexOf('.');
      if (lastDot === -1) return false;

      return RAW_TEXT_EXTENSIONS.has(lowerBase.slice(lastDot));
    }
  }

  private isRawUrl(url: string): boolean {
    const lower = url.toLowerCase();
    return (
      lower.includes('raw.githubusercontent.com') ||
      lower.includes('gist.githubusercontent.com') ||
      lower.includes('/-/raw/') ||
      BITBUCKET_RAW_RE.test(lower)
    );
  }

  private splitParams(urlString: string): { base: string; hash: string } {
    const hashIndex = urlString.indexOf('#');
    const queryIndex = urlString.indexOf('?');
    const endIndex = Math.min(
      queryIndex === -1 ? urlString.length : queryIndex,
      hashIndex === -1 ? urlString.length : hashIndex
    );

    const hash = hashIndex !== -1 ? urlString.slice(hashIndex) : '';
    return { base: urlString.slice(0, endIndex), hash };
  }

  private tryTransformWithUrl(
    base: string,
    hash: string,
    preParsed?: URL
  ): { url: string; platform: string } | null {
    let parsed: URL | null = preParsed ?? null;

    if (!parsed) {
      try {
        parsed = new URL(base);
      } catch {
        // Ignore invalid URLs
      }
    }
    if (!parsed) return null;

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      return null;

    const gist = this.transformGithubGist(base, hash);
    if (gist) return gist;

    const github = this.transformGithubBlob(base);
    if (github) return github;

    const gitlab = this.transformGitLab(base, parsed.origin);
    if (gitlab) return gitlab;

    const bitbucket = this.transformBitbucket(base, parsed.origin);
    if (bitbucket) return bitbucket;

    return null;
  }

  private transformGithubBlob(
    url: string
  ): { url: string; platform: string } | null {
    const match = GITHUB_BLOB_PATTERN.exec(url);
    if (!match) return null;

    const groups = match.pathname.groups as UrlPatternGroups;
    const owner = getPatternGroup(groups, 'owner');
    const repo = getPatternGroup(groups, 'repo');
    const branch = getPatternGroup(groups, 'branch');
    const path = getPatternGroup(groups, 'path');
    if (!owner || !repo || !branch || !path) return null;

    return {
      url: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`,
      platform: 'github',
    };
  }

  private transformGithubGist(
    url: string,
    hash: string
  ): { url: string; platform: string } | null {
    const rawMatch = GITHUB_GIST_RAW_PATTERN.exec(url);
    if (rawMatch) {
      const groups = rawMatch.pathname.groups as UrlPatternGroups;
      const user = getPatternGroup(groups, 'user');
      const gistId = getPatternGroup(groups, 'gistId');
      const filePath = getPatternGroup(groups, 'filePath');
      if (!user || !gistId) return null;

      const resolvedFilePath = filePath ? `/${filePath}` : '';

      return {
        url: `https://gist.githubusercontent.com/${user}/${gistId}/raw${resolvedFilePath}`,
        platform: 'github-gist',
      };
    }

    const match = GITHUB_GIST_PATTERN.exec(url);
    if (!match) return null;

    const groups = match.pathname.groups as UrlPatternGroups;
    const user = getPatternGroup(groups, 'user');
    const gistId = getPatternGroup(groups, 'gistId');
    if (!user || !gistId) return null;

    let filePath = '';
    if (hash.startsWith('#file-')) {
      const filename = hash.slice('#file-'.length).replace(/-/g, '.');
      if (filename) filePath = `/${filename}`;
    }

    return {
      url: `https://gist.githubusercontent.com/${user}/${gistId}/raw${filePath}`,
      platform: 'github-gist',
    };
  }

  private transformGitLab(
    url: string,
    origin: string
  ): { url: string; platform: string } | null {
    for (const pattern of GITLAB_BLOB_PATTERNS) {
      const match = pattern.exec(url);
      if (!match) continue;

      const groups = match.pathname.groups as UrlPatternGroups;
      const base = getPatternGroup(groups, 'base');
      const branch = getPatternGroup(groups, 'branch');
      const path = getPatternGroup(groups, 'path');
      if (!base || !branch || !path) return null;

      return {
        url: `${origin}/${base}/-/raw/${branch}/${path}`,
        platform: 'gitlab',
      };
    }

    return null;
  }

  private transformBitbucket(
    url: string,
    origin: string
  ): { url: string; platform: string } | null {
    const match = BITBUCKET_SRC_PATTERN.exec(url);
    if (!match) return null;

    const groups = match.pathname.groups as UrlPatternGroups;
    const owner = getPatternGroup(groups, 'owner');
    const repo = getPatternGroup(groups, 'repo');
    const branch = getPatternGroup(groups, 'branch');
    const path = getPatternGroup(groups, 'path');
    if (!owner || !repo || !branch || !path) return null;

    return {
      url: `${origin}/${owner}/${repo}/raw/${branch}/${path}`,
      platform: 'bitbucket',
    };
  }
}
