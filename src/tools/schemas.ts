import { z } from 'zod';

import { config } from '../config/index.js';

const requestOptionsSchema = z.object({
  customHeaders: z
    .record(z.string())
    .optional()
    .describe('Custom HTTP headers for the request'),
  timeout: z
    .number()
    .min(1000)
    .max(120000)
    .default(config.fetcher.timeout)
    .describe('Request timeout in milliseconds (1000-120000)'),
  retries: z
    .number()
    .min(1)
    .max(10)
    .default(3)
    .describe('Number of retry attempts (1-10)'),
});

const extractionOptionsSchema = z.object({
  extractMainContent: z
    .boolean()
    .default(true)
    .describe('Use Readability to extract main article content'),
  includeMetadata: z
    .boolean()
    .default(true)
    .describe('Include page metadata (title, description, etc.)'),
  maxContentLength: z
    .number()
    .positive()
    .optional()
    .describe('Maximum content length in characters'),
});

const formatOptionsSchema = z.object({
  format: z
    .enum(['jsonl', 'markdown'])
    .default('jsonl')
    .describe('Output format'),
});

const resourceFieldsSchema = z.object({
  contentSize: z.number().optional().describe('Content length in characters'),
  resourceUri: z
    .string()
    .optional()
    .describe('Resource URI when content is too large to inline'),
  resourceMimeType: z
    .string()
    .optional()
    .describe('MIME type for the resource URI'),
  cached: z.boolean().describe('Whether the result was served from cache'),
  truncated: z
    .boolean()
    .optional()
    .describe('Whether content was truncated by maxContentLength'),
  error: z.string().optional().describe('Error message if the request failed'),
  errorCode: z.string().optional().describe('Error code if the request failed'),
});

export const fetchUrlInputSchema = requestOptionsSchema
  .extend({
    url: z.string().min(1).describe('The URL to fetch'),
  })
  .merge(extractionOptionsSchema)
  .merge(formatOptionsSchema)
  .strict();

export const fetchMarkdownInputSchema = requestOptionsSchema
  .extend({
    url: z.string().min(1).describe('The URL to fetch'),
  })
  .merge(extractionOptionsSchema)
  .strict();

export const fetchUrlOutputSchema = z
  .object({
    url: z.string().describe('The fetched URL'),
    title: z.string().optional().describe('Page title'),
    contentBlocks: z
      .number()
      .describe('Number of content blocks extracted (JSONL only)'),
    fetchedAt: z
      .string()
      .describe('ISO timestamp of when the content was fetched'),
    format: z.enum(['jsonl', 'markdown']).describe('Output format used'),
    content: z
      .string()
      .optional()
      .describe('The extracted content in JSONL or Markdown format'),
  })
  .merge(resourceFieldsSchema)
  .strict();

export const fetchMarkdownOutputSchema = z
  .object({
    url: z.string().describe('The fetched URL'),
    title: z.string().optional().describe('Page title'),
    fetchedAt: z
      .string()
      .describe('ISO timestamp of when the content was fetched'),
    markdown: z
      .string()
      .optional()
      .describe('The extracted content in Markdown format'),
  })
  .merge(resourceFieldsSchema)
  .strict();
