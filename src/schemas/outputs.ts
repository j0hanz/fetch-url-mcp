import { z } from 'zod';

import { config } from '../lib/core.js';

import { extractedMetadataSchema } from './metadata.js';

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
