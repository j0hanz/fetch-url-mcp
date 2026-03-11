import { z } from 'zod';

import { normalizeExtractedMetadata, normalizePageTitle } from './metadata.js';

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export const cachedPayloadSchema = z
  .object({
    markdown: z
      .unknown()
      .transform((value) => normalizeString(value))
      .optional(),
    content: z
      .unknown()
      .transform((value) => normalizeString(value))
      .optional(),
    title: z
      .unknown()
      .transform((value) => normalizePageTitle(value))
      .optional(),
    metadata: z
      .unknown()
      .transform((value) => normalizeExtractedMetadata(value))
      .optional(),
    truncated: z
      .unknown()
      .transform((value) => normalizeBoolean(value))
      .optional(),
  })
  .refine(
    (value) =>
      typeof value.markdown === 'string' || typeof value.content === 'string',
    { error: 'Missing markdown/content' }
  );

export type CachedPayload = z.infer<typeof cachedPayloadSchema>;
