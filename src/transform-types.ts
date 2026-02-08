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
  title?: string;
  description?: string;
  author?: string;
  image?: string;
  favicon?: string;
  publishedAt?: string;
  modifiedAt?: string;
}

/**
 * Result of content extraction (article + metadata).
 */
export interface ExtractionResult {
  article: ExtractedArticle | null;
  metadata: ExtractedMetadata;
}

/**
 * Result of HTML to markdown transformation.
 */
export interface MarkdownTransformResult {
  markdown: string;
  title: string | undefined;
  truncated: boolean;
}

/**
 * Options for transform operations.
 */
export interface TransformOptions {
  includeMetadata: boolean;
  signal?: AbortSignal;
  skipNoiseRemoval?: boolean;
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
  includeMetadata: boolean;
  skipNoiseRemoval?: boolean | undefined;
  inputTruncated?: boolean | undefined;
}

export interface TransformWorkerCancelMessage {
  type: 'cancel';
  id: string;
}

export interface TransformWorkerResultMessage {
  type: 'result';
  id: string;
  result: { markdown: string; title?: string; truncated: boolean };
}

export interface TransformWorkerErrorMessage {
  type: 'error';
  id: string;
  error: {
    name: string;
    message: string;
    url: string;
    statusCode?: number;
    details?: Record<string, unknown>;
  };
}

export type TransformWorkerIncomingMessage =
  | TransformWorkerTransformMessage
  | TransformWorkerCancelMessage;

export type TransformWorkerOutgoingMessage =
  | TransformWorkerResultMessage
  | TransformWorkerErrorMessage;
