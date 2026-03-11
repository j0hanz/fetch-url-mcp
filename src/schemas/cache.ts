import { z } from 'zod';

const extractedMetadataSchema = z.strictObject({
  title: z.string().optional(),
  description: z.string().optional(),
  author: z.string().optional(),
  image: z.string().optional(),
  favicon: z.string().optional(),
  publishedAt: z.string().optional(),
  modifiedAt: z.string().optional(),
});

export const cachedPayloadSchema = z
  .object({
    markdown: z.string().optional(),
    content: z.string().optional(),
    title: z.string().optional(),
    metadata: extractedMetadataSchema.optional(),
    truncated: z.boolean().optional(),
  })
  .catchall(z.unknown())
  .refine(
    (value) =>
      typeof value.markdown === 'string' || typeof value.content === 'string',
    { message: 'Missing markdown/content' }
  );

export type CachedPayload = z.infer<typeof cachedPayloadSchema>;
