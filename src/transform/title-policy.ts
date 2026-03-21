import { parseUrlOrNull } from '../lib/utils.js';

export interface SyntheticTitleContext {
  readonly title: string | undefined;
  readonly favicon: string | undefined;
  readonly suppressSyntheticFavicon?: boolean;
}

const TITLE_PART_SEPARATOR = /\s*(?:[-|:•·]|–|—)\s*/u;
const LEADING_HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*$/;
const HEADING_SCAN_LIMIT = 12;

export function normalizeSyntheticTitleToken(
  value: string | undefined
): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function shouldPreferPrimaryHeadingTitle(
  primaryHeading: string | undefined,
  title: string | undefined
): boolean {
  const primary = normalizeSyntheticTitleToken(primaryHeading);
  if (!primary) return false;

  const normalizedTitle = normalizeSyntheticTitleToken(title);
  if (!normalizedTitle) return true;
  if (normalizedTitle === primary) return true;

  return normalizedTitle
    .split(TITLE_PART_SEPARATOR)
    .some((part) => part === primary);
}

export function isGithubRepositoryRootUrl(url: string): boolean {
  const parsed = parseUrlOrNull(url);
  if (!parsed) return false;

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== 'github.com' && hostname !== 'www.github.com') {
    return false;
  }

  return parsed.pathname.split('/').filter(Boolean).length === 2;
}

function normalizeHeadingText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function stripLeadingHeading(markdown: string, headingText: string): string {
  if (!markdown) return markdown;

  const lines = markdown.split('\n');
  const target = normalizeHeadingText(headingText);
  let nonEmptySeen = 0;

  for (
    let index = 0;
    index < lines.length && nonEmptySeen < HEADING_SCAN_LIMIT;
    index += 1
  ) {
    const trimmed = lines[index]?.trim() ?? '';
    if (!trimmed) continue;

    nonEmptySeen += 1;
    const match = LEADING_HEADING_PATTERN.exec(trimmed);
    if (!match) continue;

    const current = normalizeHeadingText(match[2] ?? '');
    if (current !== target) return markdown;

    lines.splice(index, 1);
    if ((lines[index] ?? '').trim() === '') {
      lines.splice(index, 1);
    }
    return lines.join('\n');
  }

  return markdown;
}

export function maybeStripGithubPrimaryHeading(
  markdown: string,
  primaryHeading: string | undefined,
  url: string
): string {
  if (primaryHeading === undefined || !isGithubRepositoryRootUrl(url)) {
    return markdown;
  }

  return stripLeadingHeading(markdown, primaryHeading);
}

function buildSyntheticTitlePrefix(
  url: string,
  favicon?: string,
  suppressFavicon?: boolean
): string {
  if (!favicon || suppressFavicon) return ' ';

  const alt = parseUrlOrNull(url)?.hostname ?? '';

  return ` ![${alt}](${favicon}) `;
}

export function maybePrependSyntheticTitle(
  markdown: string,
  context: SyntheticTitleContext,
  url: string
): string {
  if (!context.title || /^(#{1,6})\s/.test(markdown.trimStart())) {
    return markdown;
  }

  return `#${buildSyntheticTitlePrefix(
    url,
    context.favicon,
    context.suppressSyntheticFavicon
  )}${context.title}\n\n${markdown}`;
}
