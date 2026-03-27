/**
 * Shared types for the transform pipeline.
 * Extracted to avoid circular dependencies between transform modules.
 */

/**
 * Metadata block for attaching source information to markdown output.
 */
export interface MetadataBlock {
  type: 'metadata';
  title?: string;
  description?: string;
  author?: string;
  url: string;
  fetchedAt: string;
}

/**
 * Article extracted by Readability.
 */
export interface ExtractedArticle {
  title?: string;
  byline?: string;
  content: string;
  textContent: string;
  excerpt?: string;
  siteName?: string;
}

/**
 * Metadata extracted from HTML meta tags.
 */
export interface ExtractedMetadata {
  title?: string | undefined;
  description?: string | undefined;
  author?: string | undefined;
  image?: string | undefined;
  favicon?: string | undefined;
  publishedAt?: string | undefined;
  modifiedAt?: string | undefined;
}

/**
 * Result of content extraction (article + metadata).
 */
export interface ExtractionResult {
  article: ExtractedArticle | null;
  metadata: ExtractedMetadata;
}

interface MarkdownPayload {
  markdown: string;
  title?: string | undefined;
  truncated: boolean;
  metadata?: ExtractedMetadata | undefined;
}

/**
 * Result of HTML to markdown transformation.
 */
export interface MarkdownTransformResult extends MarkdownPayload {
  title: string | undefined;
}

/**
 * Options for transform operations.
 */
export interface TransformOptions {
  includeMetadataFooter: boolean;
  signal?: AbortSignal;
  inputTruncated?: boolean;
}

/**
 * Telemetry event emitted during transform stages.
 */
export interface TransformStageEvent {
  v: 1;
  type: 'stage';
  stage: string;
  durationMs: number;
  url: string;
  requestId?: string;
  operationId?: string;
  truncated?: boolean;
}

/**
 * Context for tracking transform stage timing.
 */
export interface TransformStageContext {
  readonly stage: string;
  readonly startTime: number;
  readonly url: string;
  readonly budgetMs?: number;
  readonly totalBudgetMs?: number;
}

/**
 * Worker message types for transform workers.
 */
export interface TransformWorkerTransformMessage {
  type: 'transform';
  id: string;
  html?: string | undefined;
  htmlBuffer?: Uint8Array | undefined;
  encoding?: string | undefined;
  url: string;
  includeMetadataFooter: boolean;
  inputTruncated?: boolean | undefined;
}

export interface TransformWorkerCancelledMessage {
  type: 'cancelled';
  id: string;
}

export interface TransformWorkerResultMessage {
  type: 'result';
  id: string;
  result: MarkdownPayload;
}

export interface TransformWorkerErrorMessage {
  type: 'error';
  id: string;
  error: {
    name: string;
    message: string;
    url: string;
    statusCode?: number | undefined;
    details?: Record<string, unknown> | undefined;
  };
}

export type TransformWorkerOutgoingMessage =
  | TransformWorkerResultMessage
  | TransformWorkerErrorMessage
  | TransformWorkerCancelledMessage;
