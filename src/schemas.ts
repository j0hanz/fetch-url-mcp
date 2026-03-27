import { z } from 'zod';

import { config } from './lib/core.js';

import type { ExtractedMetadata } from './transform/types.js';

const URL_FIELD_MAX_LENGTH = 2048;

const METADATA_LIMITS = {
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

type MetadataFieldName = keyof typeof METADATA_LIMITS;

function buildMetadataShape<T extends z.ZodType>(
  fieldBuilder: (max: number) => T
): Record<MetadataFieldName, T> {
  return Object.fromEntries(
    Object.entries(METADATA_LIMITS).map(([key, max]) => [
      key,
      fieldBuilder(max),
    ])
  ) as Record<MetadataFieldName, T>;
}

const normalizedMetadataSchema = z.object(
  buildMetadataShape(normalizedMetadataField)
);

export const extractedMetadataSchema: z.ZodType<ExtractedMetadata> =
  z.strictObject(
    buildMetadataShape((max) => metadataTextField(max).optional())
  );

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

export const fetchUrlInputSchema = z.strictObject(
  {
    url: z
      .httpUrl('Expected HTTP or HTTPS URL')
      .min(1, 'URL required')
      .max(
        config.constants.maxUrlLength,
        `URL exceeds ${config.constants.maxUrlLength} chars`
      )
      .describe(
        `Target URL. Max ${config.constants.maxUrlLength} chars. Example: https://example.com`
      ),
  },
  'Invalid input'
);

export const fetchUrlOutputSchema = z.strictObject({
  url: z
    .httpUrl()
    .max(config.constants.maxUrlLength)
    .describe('Normalized requested URL after validation.'),
  inputUrl: z
    .httpUrl()
    .max(config.constants.maxUrlLength)
    .describe('Original requested URL.'),
  resolvedUrl: z
    .httpUrl()
    .max(config.constants.maxUrlLength)
    .describe('Resolved fetch URL after raw-content transformations.'),
  finalUrl: z
    .httpUrl()
    .max(config.constants.maxUrlLength)
    .optional()
    .describe('Final URL after HTTP redirects.'),
  title: z.string().max(512).optional().describe('Page title.'),
  metadata: extractedMetadataSchema
    .optional()
    .describe('Extracted page metadata.'),
  markdown: (config.constants.maxInlineContentChars > 0
    ? z.string().max(config.constants.maxInlineContentChars)
    : z.string()
  ).describe('Extracted Markdown. May be truncated (check truncated field).'),
  fetchedAt: z.iso.datetime().describe('ISO timestamp of fetch.'),
  contentSize: z
    .number()
    .int()
    .min(0)
    .max(config.constants.maxHtmlBytes * 4)
    .describe('Markdown fragment size before final inline truncation.'),
  truncated: z.boolean().optional().describe('True if markdown was truncated.'),
});
