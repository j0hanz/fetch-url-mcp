import { z } from 'zod';

import { config, logWarn } from './lib/core.js';

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

const normalizedMetadataSchema = z.object({
  title: normalizedMetadataField(METADATA_LIMITS.title),
  description: normalizedMetadataField(METADATA_LIMITS.description),
  author: normalizedMetadataField(METADATA_LIMITS.author),
  image: normalizedMetadataField(METADATA_LIMITS.image),
  favicon: normalizedMetadataField(METADATA_LIMITS.favicon),
  publishedAt: normalizedMetadataField(METADATA_LIMITS.publishedAt),
  modifiedAt: normalizedMetadataField(METADATA_LIMITS.modifiedAt),
});

export const extractedMetadataSchema: z.ZodType<ExtractedMetadata> =
  z.strictObject({
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

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export interface CachedPayload {
  markdown: string;
  title?: string | undefined;
  metadata?: ExtractedMetadata | undefined;
  truncated?: boolean | undefined;
}

export const cachedPayloadValueSchema: z.ZodType<CachedPayload> =
  z.strictObject({
    markdown: z.string(),
    title: pageTitleSchema.optional(),
    metadata: extractedMetadataSchema.optional(),
    truncated: z.boolean().optional(),
  });

const cachedPayloadCompatSchema = z.object({
  markdown: z.unknown().transform((value) => normalizeString(value)),
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
});

const cachedPayloadSchema = cachedPayloadCompatSchema
  .superRefine((value, ctx) => {
    if (typeof value.markdown === 'string') return;

    ctx.addIssue({
      code: 'custom',
      message: 'Missing markdown',
      path: ['markdown'],
    });
  })
  .transform(
    (value): CachedPayload =>
      cachedPayloadValueSchema.parse({
        markdown: value.markdown,
        ...(value.title !== undefined ? { title: value.title } : {}),
        ...(value.metadata ? { metadata: value.metadata } : {}),
        ...(value.truncated !== undefined
          ? { truncated: value.truncated }
          : {}),
      })
  );

export const fetchUrlInputSchema = z.strictObject({
  url: z
    .httpUrl()
    .min(1)
    .max(config.constants.maxUrlLength)
    .describe(`Target URL. Max ${config.constants.maxUrlLength} chars.`),
  forceRefresh: z
    .boolean()
    .optional()
    .describe('Bypass cache and fetch fresh content.'),
});

export const fetchUrlOutputSchema = z.strictObject({
  url: z.httpUrl().max(config.constants.maxUrlLength).describe('Fetched URL.'),
  inputUrl: z
    .httpUrl()
    .max(config.constants.maxUrlLength)
    .optional()
    .describe('Original requested URL.'),
  resolvedUrl: z
    .httpUrl()
    .max(config.constants.maxUrlLength)
    .optional()
    .describe('Final URL after raw-content transformations.'),
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
  )
    .optional()
    .describe('Extracted Markdown. May be truncated (check truncated field).'),
  fromCache: z.boolean().optional().describe('True if served from cache.'),
  fetchedAt: z.iso.datetime().optional().describe('ISO timestamp of fetch.'),
  contentSize: z
    .number()
    .int()
    .min(0)
    .max(config.constants.maxHtmlSize * 4)
    .optional()
    .describe('Full markdown size before truncation.'),
  truncated: z.boolean().optional().describe('True if markdown was truncated.'),
});

export function parseCachedPayload(raw: string): CachedPayload | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const result = cachedPayloadSchema.safeParse(parsed);
    if (!result.success) {
      logWarn('Rejected invalid cached payload', {
        issues: result.error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
          code: issue.code,
        })),
      });
      return null;
    }
    return result.data;
  } catch {
    return null;
  }
}

export function stringifyCachedPayload(
  payload: z.input<typeof cachedPayloadValueSchema>
): string {
  return JSON.stringify(cachedPayloadValueSchema.parse(payload));
}

export function resolveCachedPayloadContent(
  payload: Partial<CachedPayload> & { markdown?: string | null }
): string | null {
  return typeof payload.markdown === 'string' ? payload.markdown : null;
}
