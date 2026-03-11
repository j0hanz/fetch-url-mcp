import { z } from 'zod';

import type { ExtractedMetadata } from '../transform/types.js';

const URL_FIELD_MAX_LENGTH = 2048;

export const METADATA_LIMITS = {
  title: 512,
  description: 2048,
  author: 512,
  image: URL_FIELD_MAX_LENGTH,
  favicon: URL_FIELD_MAX_LENGTH,
  publishedAt: 64,
  modifiedAt: 64,
} as const;

const pageTitleSchema = z.string().trim().min(1).max(METADATA_LIMITS.title);

const metadataTextField = (max: number): z.ZodString =>
  z.string().trim().min(1).max(max);

function normalizeWithSchema<T>(
  schema: z.ZodType<T>,
  value: unknown
): T | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const normalizedMetadataField = (
  max: number
): z.ZodOptional<z.ZodPipe<z.ZodUnknown, z.ZodTransform<string | undefined>>> =>
  z
    .unknown()
    .transform((value) => normalizeWithSchema(metadataTextField(max), value))
    .optional();

const normalizedMetadataSchema = z.object({
  title: normalizedMetadataField(METADATA_LIMITS.title),
  description: normalizedMetadataField(METADATA_LIMITS.description),
  author: normalizedMetadataField(METADATA_LIMITS.author),
  image: normalizedMetadataField(METADATA_LIMITS.image),
  favicon: normalizedMetadataField(METADATA_LIMITS.favicon),
  publishedAt: normalizedMetadataField(METADATA_LIMITS.publishedAt),
  modifiedAt: normalizedMetadataField(METADATA_LIMITS.modifiedAt),
});

export const extractedMetadataSchema = z.strictObject({
  title: metadataTextField(METADATA_LIMITS.title).optional(),
  description: metadataTextField(METADATA_LIMITS.description).optional(),
  author: metadataTextField(METADATA_LIMITS.author).optional(),
  image: metadataTextField(METADATA_LIMITS.image).optional(),
  favicon: metadataTextField(METADATA_LIMITS.favicon).optional(),
  publishedAt: metadataTextField(METADATA_LIMITS.publishedAt).optional(),
  modifiedAt: metadataTextField(METADATA_LIMITS.modifiedAt).optional(),
});

function compactDefined<T extends Record<string, string | undefined>>(
  value: T
): Partial<Record<keyof T, string>> {
  const result: Partial<Record<keyof T, string>> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      result[key as keyof T] = entry;
    }
  }

  return result;
}

export function normalizeExtractedMetadata(
  value: unknown
): ExtractedMetadata | undefined {
  const parsed = normalizedMetadataSchema.safeParse(value);
  if (!parsed.success) return undefined;

  const compacted = compactDefined(parsed.data);
  return Object.keys(compacted).length > 0
    ? (compacted as ExtractedMetadata)
    : undefined;
}

export function normalizePageTitle(value: unknown): string | undefined {
  return normalizeWithSchema(pageTitleSchema, value);
}
