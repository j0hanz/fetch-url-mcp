import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  McpError,
  type ServerResult,
} from '@modelcontextprotocol/sdk/types.js';

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  abortTaskExecution,
  emitTaskStatusNotification,
  type ExtendedCallToolRequest,
  handleToolCallRequest,
  throwTaskNotFound,
  toTaskSummary,
  withRelatedTaskMeta,
} from '../tasks/execution.js';
import { taskManager } from '../tasks/manager.js';
import {
  isServerResult,
  parseHandlerExtra,
  resolveTaskOwnerKey,
  resolveToolCallContext,
} from '../tasks/owner.js';
import { hasTaskCapableTool } from '../tasks/tool-registry.js';
import { transformBufferToMarkdown } from '../transform/transform.js';
import { type MarkdownTransformResult } from '../transform/types.js';
import {
  config,
  createCacheKey,
  get,
  isEnabled,
  logDebug,
  logWarn,
  runWithRequestContext,
  set,
} from './core.js';
import {
  fetchNormalizedUrlBuffer,
  normalizeUrl,
  transformToRawUrl,
} from './http.js';
import {
  FetchError,
  getErrorMessage,
  isAbortError,
  isObject,
  isSystemError,
} from './utils.js';

export type JsonRpcId = string | number | null;
interface McpRequestParams {
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}
interface McpRequestBody {
  jsonrpc: '2.0';
  method: string;
  id?: JsonRpcId;
  params?: McpRequestParams;
}
const paramsSchema = z.looseObject({});
const mcpRequestSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  method: z.string().min(1),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  params: paramsSchema.optional(),
});
export function isJsonRpcBatchRequest(body: unknown): boolean {
  return Array.isArray(body);
}
export function isMcpRequestBody(body: unknown): body is McpRequestBody {
  return mcpRequestSchema.safeParse(body).success;
}
function parseAcceptMediaTypes(
  header: string | null | undefined
): readonly string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((value) => extractAcceptMediaType(value.trim()))
    .filter((value) => value.length > 0);
}
function extractAcceptMediaType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}
export function acceptsEventStream(header: string | null | undefined): boolean {
  const mediaTypes = parseAcceptMediaTypes(header);
  return mediaTypes.some((mediaType) => mediaType === 'text/event-stream');
}
function hasAcceptedMediaType(
  mediaTypes: readonly string[],
  exact: string,
  wildcardPrefix: string
): boolean {
  return mediaTypes.some(
    (mediaType) =>
      typeof mediaType === 'string' &&
      mediaType.length > 0 &&
      (mediaType === '*/*' ||
        mediaType === exact ||
        mediaType === wildcardPrefix)
  );
}
export function acceptsJsonAndEventStream(
  header: string | null | undefined
): boolean {
  const mediaTypes = parseAcceptMediaTypes(header);
  const acceptsJson = hasAcceptedMediaType(
    mediaTypes,
    'application/json',
    'application/*'
  );
  if (!acceptsJson) return false;

  return hasAcceptedMediaType(mediaTypes, 'text/event-stream', 'text/*');
}
type CleanupCallback = () => void;
const patchedCleanupServers = new WeakSet<McpServer>();
const serverCleanupCallbacks = new WeakMap<McpServer, Set<CleanupCallback>>();
function getServerCleanupCallbackSet(server: McpServer): Set<CleanupCallback> {
  let callbacks = serverCleanupCallbacks.get(server);
  if (!callbacks) {
    callbacks = new Set<CleanupCallback>();
    serverCleanupCallbacks.set(server, callbacks);
  }
  return callbacks;
}
function drainServerCleanupCallbacks(server: McpServer): void {
  const callbacks = serverCleanupCallbacks.get(server);
  if (!callbacks || callbacks.size === 0) return;

  const pending = [...callbacks];
  callbacks.clear();
  for (const callback of pending) {
    try {
      callback();
    } catch (error: unknown) {
      logWarn('Server cleanup callback failed', { error });
    }
  }
}
function ensureServerCleanupHooks(server: McpServer): void {
  if (patchedCleanupServers.has(server)) return;
  patchedCleanupServers.add(server);

  const originalOnClose = server.server.onclose;
  server.server.onclose = () => {
    drainServerCleanupCallbacks(server);
    originalOnClose?.();
  };

  // Monkey-patching is isolated here until the SDK exposes a first-class
  // lifecycle cleanup registration API.
  const originalClose = server.close.bind(server);
  server.close = async (): Promise<void> => {
    drainServerCleanupCallbacks(server);
    await originalClose();
  };
}
export function registerServerLifecycleCleanup(
  server: McpServer,
  callback: CleanupCallback
): void {
  ensureServerCleanupHooks(server);
  getServerCleanupCallbackSet(server).add(callback);
}
export {
  cancelTasksForOwner,
  abortAllTaskExecutions,
} from '../tasks/execution.js';
const TaskGetSchema = z
  .object({
    method: z.literal('tasks/get'),
    params: z.object({ taskId: z.string() }).loose(),
  })
  .loose();
const TaskListSchema = z
  .object({
    method: z.literal('tasks/list'),
    params: z
      .object({
        cursor: z.string().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();
const TaskCancelSchema = z
  .object({
    method: z.literal('tasks/cancel'),
    params: z.object({ taskId: z.string() }).loose(),
  })
  .loose();
const TaskResultSchema = z
  .object({
    method: z.literal('tasks/result'),
    params: z.object({ taskId: z.string() }).loose(),
  })
  .loose();
const MIN_TASK_TTL_MS = 1_000;
const MAX_TASK_TTL_MS = 86_400_000;
const ExtendedCallToolRequestSchema: z.ZodType<ExtendedCallToolRequest> = z
  .object({
    method: z.literal('tools/call'),
    params: z
      .object({
        name: z.string().min(1),
        arguments: z.record(z.string(), z.unknown()).optional(),
        task: z
          .strictObject({
            ttl: z
              .number()
              .int()
              .min(MIN_TASK_TTL_MS)
              .max(MAX_TASK_TTL_MS)
              .optional(),
          })
          .optional(),
        _meta: z
          .object({
            progressToken: z.union([z.string(), z.number()]).optional(),
            'io.modelcontextprotocol/related-task': z
              .strictObject({
                taskId: z.string(),
              })
              .optional(),
          })
          .loose()
          .optional(),
      })
      .loose(),
  })
  .loose();
function parseExtendedCallToolRequest(
  request: unknown
): ExtendedCallToolRequest {
  const parsed = ExtendedCallToolRequestSchema.safeParse(request);
  if (parsed.success) return parsed.data;
  throw new McpError(ErrorCode.InvalidParams, 'Invalid tool request');
}
function resolveOwnerScopedExtra(extra: unknown): {
  parsedExtra: ReturnType<typeof parseHandlerExtra>;
  ownerKey: string;
} {
  const parsedExtra = parseHandlerExtra(extra);
  return {
    parsedExtra,
    ownerKey: resolveTaskOwnerKey(parsedExtra),
  };
}
type RequestHandlerFn = (request: unknown, extra?: unknown) => Promise<unknown>;
function getSdkCallToolHandler(server: McpServer): RequestHandlerFn | null {
  const maybeHandlers: unknown = Reflect.get(server.server, '_requestHandlers');
  if (!(maybeHandlers instanceof Map)) return null;

  const handler: unknown = maybeHandlers.get('tools/call');
  return typeof handler === 'function' ? (handler as RequestHandlerFn) : null;
}
export function registerTaskHandlers(server: McpServer): void {
  const sdkCallToolHandler = getSdkCallToolHandler(server);

  if (sdkCallToolHandler) {
    server.server.setRequestHandler(
      CallToolRequestSchema,
      async (request, extra) => {
        const parsedExtra = parseHandlerExtra(extra);
        const context = resolveToolCallContext(parsedExtra);
        const requestId =
          context.requestId !== undefined
            ? String(context.requestId)
            : randomUUID();

        const sessionId = parsedExtra?.sessionId;

        return runWithRequestContext(
          {
            requestId,
            operationId: requestId,
            ...(sessionId ? { sessionId } : {}),
          },
          () => {
            const toolName = request.params.name;

            // Only intercept task-capable tools managed by the local task registry.
            // Delegate all other tools to the SDK handler to avoid shadowing future tools.
            if (!hasTaskCapableTool(toolName)) {
              return sdkCallToolHandler(
                request,
                extra
              ) as Promise<ServerResult>;
            }

            const parsed = parseExtendedCallToolRequest(request);
            return handleToolCallRequest(server, parsed, context);
          }
        );
      }
    );
  }

  server.server.setRequestHandler(TaskGetSchema, (request, extra) => {
    const { taskId } = request.params;
    const { ownerKey } = resolveOwnerScopedExtra(extra);
    const task = taskManager.getTask(taskId, ownerKey);

    if (!task) throwTaskNotFound();

    return toTaskSummary(task);
  });

  server.server.setRequestHandler(TaskResultSchema, async (request, extra) => {
    const { taskId } = request.params;
    const { parsedExtra, ownerKey } = resolveOwnerScopedExtra(extra);

    const task = await taskManager.waitForTerminalTask(
      taskId,
      ownerKey,
      parsedExtra?.signal
    );

    if (!task) throwTaskNotFound();

    taskManager.shrinkTtlAfterDelivery(taskId);

    if (task.status === 'failed') {
      if (task.error) {
        throw new McpError(
          task.error.code,
          task.error.message,
          task.error.data
        );
      }

      const failedResult = (task.result ?? null) as ServerResult | null;
      const fallback: ServerResult = failedResult ?? {
        content: [
          {
            type: 'text',
            text: task.statusMessage ?? 'Task execution failed',
          },
        ],
        isError: true,
      };

      return withRelatedTaskMeta(fallback, task.taskId);
    }

    if (task.status === 'cancelled') {
      throw new McpError(ErrorCode.InvalidRequest, 'Task was cancelled', {
        taskId: task.taskId,
        status: 'cancelled',
        ...(task.statusMessage ? { statusMessage: task.statusMessage } : {}),
      });
    }

    if (task.status === 'input_required') {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'Task requires additional input',
        { taskId: task.taskId, status: 'input_required' }
      );
    }

    const result: ServerResult = isServerResult(task.result)
      ? task.result
      : { content: [] };

    return withRelatedTaskMeta(result, task.taskId);
  });

  server.server.setRequestHandler(TaskListSchema, (request, extra) => {
    const { ownerKey } = resolveOwnerScopedExtra(extra);
    const cursor = request.params?.cursor;

    const { tasks, nextCursor } = taskManager.listTasks(
      cursor === undefined ? { ownerKey } : { ownerKey, cursor }
    );

    return {
      tasks: tasks.map((task) => toTaskSummary(task)),
      nextCursor,
    };
  });

  server.server.setRequestHandler(TaskCancelSchema, (request, extra) => {
    const { taskId } = request.params;
    const { ownerKey } = resolveOwnerScopedExtra(extra);

    const task = taskManager.cancelTask(taskId, ownerKey);
    if (!task) throwTaskNotFound();

    abortTaskExecution(taskId);

    emitTaskStatusNotification(server, task);

    return toTaskSummary(task);
  });
}
type ToolErrorResponse = CallToolResult & {
  isError: true;
};
export function createToolErrorResponse(
  message: string,
  url: string,
  extra?: {
    code?: string;
    statusCode?: number;
    details?: Record<string, unknown>;
  }
): ToolErrorResponse {
  const errorContent: Record<string, unknown> = {
    error: message,
    ...(extra?.code ? { code: extra.code } : {}),
    url,
    ...(extra?.statusCode !== undefined
      ? { statusCode: extra.statusCode }
      : {}),
    ...(extra?.details ? { details: extra.details } : {}),
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(errorContent) }],
    isError: true,
  };
}
function isValidationError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    isSystemError(error) &&
    error.code === 'VALIDATION_ERROR'
  );
}
function isHandledToolError(
  error: unknown
): error is FetchError | NodeJS.ErrnoException {
  return error instanceof FetchError || isValidationError(error);
}
function resolveToolErrorMessage(
  error: unknown,
  fallbackMessage: string
): string {
  if (isHandledToolError(error)) {
    return error.message;
  }
  if (error instanceof Error) {
    return `${fallbackMessage}: ${error.message}`;
  }
  return `${fallbackMessage}: Unknown error`;
}
function resolveToolErrorCode(error: unknown): string {
  if (error instanceof FetchError) return error.code;
  if (isValidationError(error)) return 'VALIDATION_ERROR';
  if (isAbortError(error)) return 'ABORTED';
  return 'FETCH_ERROR';
}
export function handleToolError(
  error: unknown,
  url: string,
  fallbackMessage = 'Operation failed'
): ToolErrorResponse {
  const message = resolveToolErrorMessage(error, fallbackMessage);
  const code = resolveToolErrorCode(error);
  if (error instanceof FetchError) {
    return createToolErrorResponse(message, url, {
      code,
      statusCode: error.statusCode,
      details: error.details,
    });
  }
  return createToolErrorResponse(message, url, { code });
}
type JsonRecord = Record<string, unknown>;
function asRecord(value: unknown): JsonRecord | undefined {
  return isObject(value) ? (value as JsonRecord) : undefined;
}
function readUnknown(obj: unknown, key: string): unknown {
  const record = asRecord(obj);
  return record ? record[key] : undefined;
}
export function readString(obj: unknown, key: string): string | undefined {
  const value = readUnknown(obj, key);
  return typeof value === 'string' ? value : undefined;
}
export function readNestedRecord(
  obj: unknown,
  keys: readonly string[]
): JsonRecord | undefined {
  let current: unknown = obj;
  for (const key of keys) {
    current = readUnknown(current, key);
    if (current === undefined) return undefined;
  }
  return asRecord(current);
}
function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
export function withSignal(
  signal?: AbortSignal
): { signal: AbortSignal } | Record<string, never> {
  return signal === undefined ? {} : { signal };
}
export const TRUNCATION_MARKER = '...[truncated]';
export interface InlineContentResult {
  content?: string;
  contentSize: number;
  truncated?: boolean;
}
function getOpenCodeFence(
  content: string
): { fenceChar: string; fenceLength: number } | null {
  const FENCE_PATTERN = /^([ \t]*)(`{3,}|~{3,})/gm;
  let match;
  let inFence = false;
  let fenceChar: string | null = null;
  let fenceLength = 0;

  while ((match = FENCE_PATTERN.exec(content)) !== null) {
    const marker = match[2];
    if (!marker) continue;

    const [char] = marker;
    if (!char) continue;
    const { length } = marker;

    if (!inFence) {
      inFence = true;
      fenceChar = char;
      fenceLength = length;
    } else if (char === fenceChar && length >= fenceLength) {
      inFence = false;
      fenceChar = null;
      fenceLength = 0;
    }
  }

  if (inFence && fenceChar) {
    return { fenceChar, fenceLength };
  }
  return null;
}
function findSafeLinkBoundary(content: string, limit: number): number {
  const lastBracket = content.lastIndexOf('[', limit);
  if (lastBracket === -1) return limit;
  const afterBracket = content.substring(lastBracket, limit);
  const closedPattern = /^\[[^\]]*\]\([^)]*\)/;
  if (closedPattern.test(afterBracket)) return limit;
  const start =
    lastBracket > 0 && content[lastBracket - 1] === '!'
      ? lastBracket - 1
      : lastBracket;
  return start;
}
function truncateWithMarker(
  content: string,
  limit: number,
  marker: string
): string {
  if (content.length <= limit) return content;
  const maxContentLength = Math.max(0, limit - marker.length);
  const tentativeContent = content.substring(0, maxContentLength);
  const openFence = getOpenCodeFence(tentativeContent);
  if (openFence) {
    const fenceCloser = `\n${openFence.fenceChar.repeat(openFence.fenceLength)}\n`;
    const adjustedLength = Math.max(
      0,
      limit - marker.length - fenceCloser.length
    );
    return `${content.substring(0, adjustedLength)}${fenceCloser}${marker}`;
  }

  const safeBoundary = findSafeLinkBoundary(content, maxContentLength);
  if (safeBoundary < maxContentLength) {
    return `${content.substring(0, safeBoundary)}${marker}`.slice(0, limit);
  }

  return `${tentativeContent}${marker}`.slice(0, limit);
}
export function appendTruncationMarker(
  content: string,
  marker: string
): string {
  if (!content) return marker;
  if (content.endsWith(marker)) return content;

  const openFence = getOpenCodeFence(content);
  const contentWithFence = openFence
    ? `${content}\n${openFence.fenceChar.repeat(openFence.fenceLength)}\n`
    : content;

  const safeBoundary = findSafeLinkBoundary(
    contentWithFence,
    contentWithFence.length
  );
  if (safeBoundary < contentWithFence.length) {
    return `${contentWithFence.substring(0, safeBoundary)}${marker}`;
  }

  return `${contentWithFence}${marker}`;
}
class InlineContentLimiter {
  apply(content: string, inlineLimitOverride?: number): InlineContentResult {
    const contentSize = content.length;
    const inlineLimit = this.resolveInlineLimit(inlineLimitOverride);

    if (isWithinInlineLimit(contentSize, inlineLimit)) {
      return { content, contentSize };
    }

    const truncatedContent = truncateWithMarker(
      content,
      inlineLimit,
      TRUNCATION_MARKER
    );

    return {
      content: truncatedContent,
      contentSize,
      truncated: true,
    };
  }

  private resolveInlineLimit(inlineLimitOverride?: number): number {
    const globalLimit = config.constants.maxInlineContentChars;

    if (inlineLimitOverride === undefined) return globalLimit;
    if (globalLimit > 0 && inlineLimitOverride > 0) {
      return Math.min(inlineLimitOverride, globalLimit);
    }

    return inlineLimitOverride;
  }
}
function isWithinInlineLimit(
  contentSize: number,
  inlineLimit: number
): boolean {
  return inlineLimit <= 0 || contentSize <= inlineLimit;
}
const inlineLimiter = new InlineContentLimiter();
function applyInlineContentLimit(
  content: string,
  inlineLimitOverride?: number
): InlineContentResult {
  return inlineLimiter.apply(content, inlineLimitOverride);
}
interface FetchPipelineOptions<T> {
  url: string;
  cacheNamespace: string;
  signal?: AbortSignal;
  cacheVary?: Record<string, unknown> | string;
  forceRefresh?: boolean;
  transform: (
    input: { buffer: Uint8Array; encoding: string; truncated?: boolean },
    url: string
  ) => T | Promise<T>;
  serialize?: (result: T) => string;
  deserialize?: (cached: string) => T | undefined;
}
export interface PipelineResult<T> {
  data: T;
  fromCache: boolean;
  url: string;
  originalUrl?: string;
  finalUrl?: string;
  fetchedAt: string;
  cacheKey?: string | null;
}
interface UrlResolution {
  normalizedUrl: string;
  originalUrl: string;
  transformed: boolean;
}
function resolveNormalizedUrl(url: string): UrlResolution {
  const { normalizedUrl: validatedUrl } = normalizeUrl(url);
  const transformedResult = transformToRawUrl(validatedUrl);
  if (!transformedResult.transformed) {
    return {
      normalizedUrl: validatedUrl,
      originalUrl: validatedUrl,
      transformed: false,
    };
  }

  const { normalizedUrl: transformedUrl } = normalizeUrl(transformedResult.url);
  return {
    normalizedUrl: transformedUrl,
    originalUrl: validatedUrl,
    transformed: true,
  };
}
function logRawUrlTransformation(resolvedUrl: UrlResolution): void {
  if (!resolvedUrl.transformed) return;

  logDebug('Using transformed raw content URL', {
    original: resolvedUrl.originalUrl,
  });
}
function extractTitle(value: unknown): string | undefined {
  return readString(value, 'title');
}
function logCacheMiss(
  reason: string,
  cacheNamespace: string,
  normalizedUrl: string,
  error?: unknown
): void {
  const log = reason.startsWith('deserialize') ? logWarn : logDebug;
  log(`Cache miss due to ${reason}`, {
    namespace: cacheNamespace,
    url: normalizedUrl,
    ...(error ? { error: getErrorMessage(error) } : {}),
  });
}
function createCacheHitResult<T>(params: {
  data: T;
  normalizedUrl: string;
  cachedUrl: string;
  fetchedAt: string;
  cacheKey: string;
}): PipelineResult<T> {
  const finalUrl =
    params.cachedUrl !== params.normalizedUrl ? params.cachedUrl : undefined;

  return {
    data: params.data,
    fromCache: true,
    url: params.normalizedUrl,
    ...(finalUrl ? { finalUrl } : {}),
    fetchedAt: params.fetchedAt,
    cacheKey: params.cacheKey,
  };
}
function attemptCacheRetrieval<T>(params: {
  cacheKey: string | null;
  deserialize: ((cached: string) => T | undefined) | undefined;
  cacheNamespace: string;
  normalizedUrl: string;
}): PipelineResult<T> | null {
  const { cacheKey, deserialize, cacheNamespace, normalizedUrl } = params;
  if (!cacheKey) return null;

  const cached = get(cacheKey);
  if (!cached) return null;

  if (!deserialize) {
    logCacheMiss('missing deserializer', cacheNamespace, normalizedUrl);
    return null;
  }

  let data: T | undefined;
  try {
    data = deserialize(cached.content);
  } catch (error: unknown) {
    logCacheMiss('deserialize exception', cacheNamespace, normalizedUrl, error);
    return null;
  }

  if (data === undefined) {
    logCacheMiss('deserialize failure', cacheNamespace, normalizedUrl);
    return null;
  }

  logDebug('Cache hit', { namespace: cacheNamespace, url: normalizedUrl });

  return createCacheHitResult({
    data,
    normalizedUrl,
    cachedUrl: cached.url,
    fetchedAt: cached.fetchedAt,
    cacheKey,
  });
}
function persistCache<T>(params: {
  cacheKey: string | null;
  data: T;
  serialize: ((result: T) => string) | undefined;
  normalizedUrl: string;
  cacheNamespace: string;
  force?: boolean;
}): void {
  const { cacheKey, data, serialize, normalizedUrl, cacheNamespace, force } =
    params;
  if (!cacheKey) return;

  const serializer = serialize ?? JSON.stringify;
  const title = extractTitle(data);
  const metadata = {
    url: normalizedUrl,
    ...(title === undefined ? {} : { title }),
  };

  try {
    set(
      cacheKey,
      serializer(data),
      metadata,
      force ? { force: true } : undefined
    );
  } catch (error: unknown) {
    logWarn('Failed to persist cache entry', {
      namespace: cacheNamespace,
      url: normalizedUrl,
      error: getErrorMessage(error),
    });
  }
}
export async function executeFetchPipeline<T>(
  options: FetchPipelineOptions<T>
): Promise<PipelineResult<T>> {
  const resolvedUrl = resolveNormalizedUrl(options.url);
  logRawUrlTransformation(resolvedUrl);

  const cacheKey = createCacheKey(
    options.cacheNamespace,
    resolvedUrl.normalizedUrl,
    options.cacheVary
  );

  if (!options.forceRefresh) {
    const cachedResult = attemptCacheRetrieval({
      cacheKey,
      deserialize: options.deserialize,
      cacheNamespace: options.cacheNamespace,
      normalizedUrl: resolvedUrl.normalizedUrl,
    });
    if (cachedResult) {
      return { ...cachedResult, originalUrl: resolvedUrl.originalUrl };
    }
  }

  logDebug('Fetching URL', { url: resolvedUrl.normalizedUrl });

  const { buffer, encoding, truncated, finalUrl } =
    await fetchNormalizedUrlBuffer(
      resolvedUrl.normalizedUrl,
      withSignal(options.signal)
    );
  const resolvedFinalUrl = finalUrl || resolvedUrl.normalizedUrl;
  const transformUrl = resolvedFinalUrl;
  const data = await options.transform(
    { buffer, encoding, ...(truncated ? { truncated: true } : {}) },
    transformUrl
  );

  if (isEnabled()) {
    persistCache({
      cacheKey,
      data,
      serialize: options.serialize,
      normalizedUrl: resolvedFinalUrl,
      cacheNamespace: options.cacheNamespace,
    });

    if (finalUrl && finalUrl !== resolvedUrl.normalizedUrl) {
      const finalCacheKey = createCacheKey(
        options.cacheNamespace,
        finalUrl,
        options.cacheVary
      );
      if (finalCacheKey && finalCacheKey !== cacheKey) {
        persistCache({
          cacheKey: finalCacheKey,
          data,
          serialize: options.serialize,
          normalizedUrl: finalUrl,
          cacheNamespace: options.cacheNamespace,
        });
      }
    }
  }

  return {
    data,
    fromCache: false,
    url: resolvedUrl.normalizedUrl,
    originalUrl: resolvedUrl.originalUrl,
    finalUrl,
    fetchedAt: new Date().toISOString(),
    cacheKey,
  };
}
export type MarkdownPipelineResult = MarkdownTransformResult & {
  readonly content: string;
};
function normalizeExtractedMetadata(
  metadata:
    | {
        title?: string | undefined;
        description?: string | undefined;
        author?: string | undefined;
        image?: string | undefined;
        favicon?: string | undefined;
        publishedAt?: string | undefined;
        modifiedAt?: string | undefined;
      }
    | undefined
): MarkdownPipelineResult['metadata'] | undefined {
  if (!metadata) return undefined;

  const normalized = Object.fromEntries(
    Object.entries(metadata).filter(([, v]) => Boolean(v))
  );

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}
const cachedMarkdownSchema = z
  .object({
    markdown: z.string().optional(),
    content: z.string().optional(),
    title: z.string().optional(),
    metadata: z
      .strictObject({
        title: z.string().optional(),
        description: z.string().optional(),
        author: z.string().optional(),
        image: z.string().optional(),
        favicon: z.string().optional(),
        publishedAt: z.string().optional(),
        modifiedAt: z.string().optional(),
      })
      .optional(),
    truncated: z.boolean().optional(),
  })
  .catchall(z.unknown())
  .refine(
    (value) =>
      typeof value.markdown === 'string' || typeof value.content === 'string',
    { message: 'Missing markdown/content' }
  );
export function parseCachedMarkdownResult(
  cached: string
): MarkdownPipelineResult | undefined {
  const parsed = safeJsonParse(cached);
  const result = cachedMarkdownSchema.safeParse(parsed);
  if (!result.success) return undefined;

  const markdown = result.data.markdown ?? result.data.content;
  if (typeof markdown !== 'string') return undefined;

  const metadata = normalizeExtractedMetadata(result.data.metadata);

  const truncated = result.data.truncated ?? false;
  const persistedMarkdown = truncated
    ? appendTruncationMarker(markdown, TRUNCATION_MARKER)
    : markdown;

  return {
    content: persistedMarkdown,
    markdown: persistedMarkdown,
    title: result.data.title,
    ...(metadata ? { metadata } : {}),
    truncated,
  };
}
export const markdownTransform = async (
  input: { buffer: Uint8Array; encoding: string; truncated?: boolean },
  url: string,
  signal?: AbortSignal,
  skipNoiseRemoval?: boolean
): Promise<MarkdownPipelineResult> => {
  const result = await transformBufferToMarkdown(input.buffer, url, {
    includeMetadata: true,
    encoding: input.encoding,
    ...withSignal(signal),
    ...(skipNoiseRemoval ? { skipNoiseRemoval: true } : {}),
    ...(input.truncated ? { inputTruncated: true } : {}),
  });
  const truncated = Boolean(result.truncated || input.truncated);
  return { ...result, content: result.markdown, truncated };
};
export function serializeMarkdownResult(
  result: MarkdownPipelineResult
): string {
  const persistedMarkdown = result.truncated
    ? appendTruncationMarker(result.markdown, TRUNCATION_MARKER)
    : result.markdown;

  return JSON.stringify({
    markdown: persistedMarkdown,
    title: result.title,
    metadata: result.metadata,
    truncated: result.truncated,
  });
}
interface SharedFetchOptions {
  readonly url: string;
  readonly signal?: AbortSignal;
  readonly cacheVary?: Record<string, unknown> | string;
  readonly forceRefresh?: boolean;
  readonly maxInlineChars?: number;
  readonly transform: (
    input: { buffer: Uint8Array; encoding: string; truncated?: boolean },
    normalizedUrl: string
  ) => MarkdownPipelineResult | Promise<MarkdownPipelineResult>;
  readonly serialize?: (result: MarkdownPipelineResult) => string;
  readonly deserialize?: (cached: string) => MarkdownPipelineResult | undefined;
}
interface SharedFetchDeps {
  readonly executeFetchPipeline?: typeof executeFetchPipeline;
}
export async function performSharedFetch(
  options: SharedFetchOptions,
  deps: SharedFetchDeps = {}
): Promise<{
  pipeline: PipelineResult<MarkdownPipelineResult>;
  inlineResult: InlineContentResult;
}> {
  const executePipeline = deps.executeFetchPipeline ?? executeFetchPipeline;

  const pipelineOptions: FetchPipelineOptions<MarkdownPipelineResult> = {
    url: options.url,
    cacheNamespace: 'markdown',
    ...withSignal(options.signal),
    ...(options.cacheVary ? { cacheVary: options.cacheVary } : {}),
    ...(options.forceRefresh ? { forceRefresh: true } : {}),
    transform: options.transform,
    ...(options.serialize ? { serialize: options.serialize } : {}),
    ...(options.deserialize ? { deserialize: options.deserialize } : {}),
  };

  const pipeline = await executePipeline(pipelineOptions);
  const inlineResult = applyInlineContentLimit(
    pipeline.data.content,
    options.maxInlineChars
  );

  return { pipeline, inlineResult };
}
type ProgressToken = string | number;
interface RequestMeta {
  progressToken?: ProgressToken | undefined;
  [key: string]: unknown;
}
export interface ProgressNotificationParams {
  progressToken: ProgressToken;
  progress: number;
  total?: number;
  message?: string;
  _meta?: Record<string, unknown>;
}
export interface ProgressNotification {
  method: 'notifications/progress';
  params: ProgressNotificationParams;
}
export interface ToolHandlerExtra {
  signal?: AbortSignal;
  requestId?: string | number;
  sessionId?: unknown;
  requestInfo?: unknown;
  _meta?: RequestMeta;
  sendNotification?: (notification: ProgressNotification) => Promise<void>;
  onProgress?: (progress: number, message: string) => void;
}
export interface ProgressReporter {
  report: (progress: number, message: string) => void;
}
const FETCH_PROGRESS_TOTAL = 4;
const PROGRESS_NOTIFICATION_TIMEOUT_MS = 5000;
function resolveRelatedTaskMeta(
  meta?: RequestMeta
): { taskId: string } | undefined {
  if (!meta) return undefined;
  const related = meta['io.modelcontextprotocol/related-task'];
  if (!isObject(related)) return undefined;
  const { taskId } = related as { taskId?: unknown };
  return typeof taskId === 'string' ? { taskId } : undefined;
}
class ToolProgressReporter implements ProgressReporter {
  private reportQueue: Promise<void> = Promise.resolve();
  private isTerminal = false;
  private lastProgress = -1;

  private constructor(
    private readonly token: ProgressToken | null,
    private readonly sendNotification:
      | ((notification: ProgressNotification) => Promise<void>)
      | undefined,
    private readonly relatedTaskMeta: { taskId: string } | undefined,
    private readonly onProgress:
      | ((progress: number, message: string) => void)
      | undefined
  ) {}

  static create(extra?: ToolHandlerExtra): ProgressReporter {
    const token = extra?._meta?.progressToken ?? null;
    const sendNotification = extra?.sendNotification;
    const relatedTaskMeta = resolveRelatedTaskMeta(extra?._meta);
    const onProgress = extra?.onProgress;

    if (token === null && !onProgress) {
      return { report: () => {} };
    }

    return new ToolProgressReporter(
      token,
      sendNotification,
      relatedTaskMeta,
      onProgress
    );
  }

  report(progress: number, message: string): void {
    if (this.isTerminal) return;
    const effectiveProgress = Math.max(progress, this.lastProgress);
    const isIncreasing = effectiveProgress > this.lastProgress;
    this.lastProgress = effectiveProgress;

    if (effectiveProgress >= FETCH_PROGRESS_TOTAL) {
      this.isTerminal = true;
    }
    // Only fire onProgress when progress actually increases to avoid duplicate
    // task status updates (onProgress drives updateWorkingTaskStatus in task mode).
    if (isIncreasing && this.onProgress) {
      try {
        this.onProgress(effectiveProgress, message);
      } catch (error: unknown) {
        logWarn('Progress callback failed', {
          error: getErrorMessage(error),
          progress: effectiveProgress,
          message,
        });
      }
    }
    if (!isIncreasing || this.token === null || !this.sendNotification) return;
    const { sendNotification } = this;

    const notification = this.createProgressNotification(
      this.token,
      effectiveProgress,
      message
    );

    this.reportQueue = this.reportQueue.then(async () => {
      let timeoutId: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<{ timeout: true }>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve({ timeout: true });
        }, PROGRESS_NOTIFICATION_TIMEOUT_MS);
        timeoutId.unref();
      });

      try {
        const outcome = await Promise.race([
          sendNotification(notification).then(() => ({ ok: true as const })),
          timeoutPromise,
        ]);

        if ('timeout' in outcome) {
          logWarn('Progress notification timed out', { progress, message });
        }
      } catch (error) {
        logWarn('Failed to send progress notification', {
          error: getErrorMessage(error),
          progress,
          message,
        });
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    });
    // Do not await reportQueue: notifications drain asynchronously so the caller
    // is not blocked for up to N × PROGRESS_NOTIFICATION_TIMEOUT_MS.
  }

  private createProgressNotification(
    token: ProgressToken,
    progress: number,
    message: string
  ): ProgressNotification {
    return {
      method: 'notifications/progress',
      params: {
        progressToken: token,
        progress,
        total: FETCH_PROGRESS_TOTAL,
        message,
        ...(this.relatedTaskMeta
          ? {
              _meta: {
                'io.modelcontextprotocol/related-task': this.relatedTaskMeta,
              },
            }
          : {}),
      },
    };
  }
}
export function createProgressReporter(
  extra?: ToolHandlerExtra
): ProgressReporter {
  return ToolProgressReporter.create(extra);
}
