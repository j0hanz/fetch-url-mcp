import type { ExtractedMetadata } from '../config/types/content.js';

export type MetaSource = 'og' | 'twitter' | 'standard';
export type MetaField = keyof ExtractedMetadata;

export interface MetaCollectorState {
  title: Partial<Record<MetaSource, string>>;
  description: Partial<Record<MetaSource, string>>;
  author: Partial<Record<MetaSource, string>>;
}

export function createMetaCollectorState(): MetaCollectorState {
  return {
    title: {},
    description: {},
    author: {},
  };
}

export function resolveMetaField(
  state: MetaCollectorState,
  field: MetaField
): string | undefined {
  const sources = state[field];
  return sources.og ?? sources.twitter ?? sources.standard;
}
