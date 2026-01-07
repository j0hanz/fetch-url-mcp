import { config } from '../../config/index.js';
import type {
  FetchPipelineOptions,
  PipelineResult,
  ToolContentBlock,
} from '../../config/types/runtime.js';

import { generateSafeFilename } from '../../utils/filename-generator.js';
import { executeFetchPipeline } from '../utils/fetch-pipeline.js';
import { applyInlineContentLimit } from '../utils/inline-content.js';

interface SharedFetchOptions<T extends { content: string }> {
  readonly url: string;
  readonly transform: (html: string, normalizedUrl: string) => T | Promise<T>;
  readonly serialize?: (result: T) => string;
  readonly deserialize?: (cached: string) => T | undefined;
}

interface SharedFetchDeps {
  readonly executeFetchPipeline?: typeof executeFetchPipeline;
}

function applyOptionalPipelineSerialization<T extends { content: string }>(
  pipelineOptions: FetchPipelineOptions<T>,
  options: SharedFetchOptions<T>
): void {
  if (options.serialize !== undefined) {
    pipelineOptions.serialize = options.serialize;
  }

  if (options.deserialize !== undefined) {
    pipelineOptions.deserialize = options.deserialize;
  }
}

export async function performSharedFetch<T extends { content: string }>(
  options: SharedFetchOptions<T>,
  deps: SharedFetchDeps = {}
): Promise<{
  pipeline: PipelineResult<T>;
  inlineResult: ReturnType<typeof applyInlineContentLimit>;
}> {
  const executePipeline = deps.executeFetchPipeline ?? executeFetchPipeline;

  const pipelineOptions: FetchPipelineOptions<T> = {
    url: options.url,
    cacheNamespace: 'markdown',
    transform: options.transform,
  };

  applyOptionalPipelineSerialization(pipelineOptions, options);

  const pipeline = await executePipeline<T>(pipelineOptions);

  const inlineResult = applyInlineContentLimit(
    pipeline.data.content,
    pipeline.cacheKey ?? null
  );

  return { pipeline, inlineResult };
}

export type InlineResult = ReturnType<typeof applyInlineContentLimit>;

function serializeStructuredContent(
  structuredContent: Record<string, unknown>,
  fromCache: boolean
): string {
  return JSON.stringify(
    structuredContent,
    fromCache ? undefined : null,
    fromCache ? undefined : 2
  );
}

function buildResourceLink(
  inlineResult: InlineResult,
  name: string
): ToolContentBlock | null {
  if (!inlineResult.resourceUri) {
    return null;
  }

  const block: ToolContentBlock = {
    type: 'resource_link',
    uri: inlineResult.resourceUri,
    name,
    description: `Content exceeds inline limit (${config.constants.maxInlineContentChars} chars)`,
  };

  if (inlineResult.resourceMimeType !== undefined) {
    block.mimeType = inlineResult.resourceMimeType;
  }

  return block;
}

function buildEmbeddedResource(
  content: string,
  url: string,
  title?: string
): ToolContentBlock | null {
  if (!content) {
    return null;
  }

  const filename = generateSafeFilename(url, title, undefined, '.md');
  const uri = `file:///${filename}`;

  return {
    type: 'resource',
    resource: {
      uri,
      mimeType: 'text/markdown',
      text: content,
    },
  };
}

function resolveContentToEmbed(
  inlineResult: InlineResult,
  fullContent: string | undefined,
  useInlineInHttpMode: boolean
): unknown {
  if (useInlineInHttpMode) {
    return inlineResult.content;
  }
  return fullContent ?? inlineResult.content;
}

function maybeAppendEmbeddedResource(
  blocks: ToolContentBlock[],
  contentToEmbed: unknown,
  url: string | undefined,
  title: string | undefined
): void {
  if (typeof contentToEmbed !== 'string') return;
  if (!url) return;

  const embeddedResource = buildEmbeddedResource(contentToEmbed, url, title);
  if (embeddedResource) {
    blocks.push(embeddedResource);
  }
}

function maybeAppendResourceLink(
  blocks: ToolContentBlock[],
  inlineResult: InlineResult,
  resourceName: string
): void {
  const resourceLink = buildResourceLink(inlineResult, resourceName);
  if (resourceLink) {
    blocks.push(resourceLink);
  }
}

function buildTextBlock(
  structuredContent: Record<string, unknown>,
  fromCache: boolean
): ToolContentBlock {
  return {
    type: 'text',
    text: serializeStructuredContent(structuredContent, fromCache),
  };
}

export function buildToolContentBlocks(
  structuredContent: Record<string, unknown>,
  fromCache: boolean,
  inlineResult: InlineResult,
  resourceName: string,
  cacheKey?: string | null,
  fullContent?: string,
  url?: string,
  title?: string
): ToolContentBlock[] {
  const blocks: ToolContentBlock[] = [
    buildTextBlock(structuredContent, fromCache),
  ];

  const contentToEmbed = resolveContentToEmbed(
    inlineResult,
    fullContent,
    config.runtime.httpMode
  );
  maybeAppendEmbeddedResource(blocks, contentToEmbed, url, title);
  maybeAppendResourceLink(blocks, inlineResult, resourceName);

  return blocks;
}
