import type { ExtractedMetadata } from '../config/types/content.js';

type MetaSource = 'og' | 'twitter' | 'standard';
type MetaField = keyof ExtractedMetadata;

interface MetaCollectorState {
  title: Partial<Record<MetaSource, string>>;
  description: Partial<Record<MetaSource, string>>;
  author: Partial<Record<MetaSource, string>>;
}

function createMetaCollectorState(): MetaCollectorState {
  return {
    title: {},
    description: {},
    author: {},
  };
}

function resolveMetaField(
  state: MetaCollectorState,
  field: MetaField
): string | undefined {
  const sources = state[field];
  return sources.og ?? sources.twitter ?? sources.standard;
}

function collectMetaTag(state: MetaCollectorState, tag: HTMLMetaElement): void {
  const content = tag.getAttribute('content')?.trim();
  if (!content) return;

  const property = tag.getAttribute('property');
  if (property?.startsWith('og:')) {
    const key = property.replace('og:', '');
    if (key === 'title') state.title.og = content;
    if (key === 'description') state.description.og = content;
    return;
  }

  const name = tag.getAttribute('name');
  if (name?.startsWith('twitter:')) {
    const key = name.replace('twitter:', '');
    if (key === 'title') state.title.twitter = content;
    if (key === 'description') state.description.twitter = content;
    return;
  }

  if (name === 'description') {
    state.description.standard = content;
  }
  if (name === 'author') {
    state.author.standard = content;
  }
}

function scanMetaTags(document: Document, state: MetaCollectorState): void {
  const metaTags = document.querySelectorAll('meta');
  for (const tag of metaTags) {
    collectMetaTag(state, tag);
  }
}

function ensureTitleFallback(
  document: Document,
  state: MetaCollectorState
): void {
  if (state.title.standard) return;
  const titleEl = document.querySelector('title');
  if (titleEl?.textContent) {
    state.title.standard = titleEl.textContent.trim();
  }
}

export function extractMetadata(document: Document): ExtractedMetadata {
  const state = createMetaCollectorState();

  scanMetaTags(document, state);
  ensureTitleFallback(document, state);

  const metadata: ExtractedMetadata = {};
  const title = resolveMetaField(state, 'title');
  const description = resolveMetaField(state, 'description');
  const author = resolveMetaField(state, 'author');

  if (title !== undefined) metadata.title = title;
  if (description !== undefined) metadata.description = description;
  if (author !== undefined) metadata.author = author;

  return metadata;
}
