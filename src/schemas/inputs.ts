import { z } from 'zod';

import { config } from '../lib/core.js';

export const fetchUrlInputSchema = z.strictObject({
  url: z
    .url({ protocol: /^https?$/i })
    .min(1)
    .max(config.constants.maxUrlLength)
    .describe(`Target URL. Max ${config.constants.maxUrlLength} chars.`),
  skipNoiseRemoval: z
    .boolean()
    .optional()
    .describe('Preserve navigation/footers (disable noise filtering).'),
  forceRefresh: z
    .boolean()
    .optional()
    .describe('Bypass cache and fetch fresh content.'),
  maxInlineChars: z
    .number()
    .int()
    .min(0)
    .max(config.constants.maxHtmlSize)
    .optional()
    .describe(
      `Inline markdown limit (0-${config.constants.maxHtmlSize}, 0=unlimited). Lower of this or global limit applies.`
    ),
});
