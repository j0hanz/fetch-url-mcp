import { z } from 'zod';

import { config } from '../lib/core.js';

export const fetchUrlOutputSchema = z.strictObject({
  url: z
    .string()
    .min(1)
    .max(config.constants.maxUrlLength)
    .describe('Fetched URL.'),
  inputUrl: z
    .string()
    .max(config.constants.maxUrlLength)
    .optional()
    .describe('Original requested URL.'),
  resolvedUrl: z
    .string()
    .max(config.constants.maxUrlLength)
    .optional()
    .describe('Final URL after raw-content transformations.'),
  finalUrl: z
    .string()
    .max(config.constants.maxUrlLength)
    .optional()
    .describe('Final URL after HTTP redirects.'),
  cacheResourceUri: z
    .string()
    .max(config.constants.maxUrlLength)
    .optional()
    .describe('URI for resources/read to get full markdown.'),
  title: z.string().max(512).optional().describe('Page title.'),
  metadata: z
    .strictObject({
      title: z.string().max(512).optional().describe('Detected page title.'),
      description: z
        .string()
        .max(2048)
        .optional()
        .describe('Detected page description.'),
      author: z.string().max(512).optional().describe('Detected page author.'),
      image: z
        .string()
        .max(config.constants.maxUrlLength)
        .optional()
        .describe('Detected page preview image URL.'),
      favicon: z
        .string()
        .max(config.constants.maxUrlLength)
        .optional()
        .describe('Detected page favicon URL.'),
      publishedAt: z
        .string()
        .max(64)
        .optional()
        .describe('Detected publication date.'),
      modifiedAt: z
        .string()
        .max(64)
        .optional()
        .describe('Detected last modified date.'),
    })
    .optional()
    .describe('Extracted page metadata.'),
  markdown: (config.constants.maxInlineContentChars > 0
    ? z.string().max(config.constants.maxInlineContentChars)
    : z.string()
  )
    .optional()
    .describe('Extracted Markdown. May be truncated (check truncated field).'),
  fromCache: z.boolean().optional().describe('True if served from cache.'),
  fetchedAt: z.string().max(64).optional().describe('ISO timestamp of fetch.'),
  contentSize: z
    .number()
    .int()
    .min(0)
    .max(config.constants.maxHtmlSize * 4)
    .optional()
    .describe('Full markdown size before truncation.'),
  truncated: z.boolean().optional().describe('True if markdown was truncated.'),
});
