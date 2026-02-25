import { getErrorMessage } from './errors.js';
import { logWarn } from './observability.js';
import { isObject } from './type-guards.js';

/* -------------------------------------------------------------------------------------------------
 * Types
 * ------------------------------------------------------------------------------------------------- */

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
  report: (progress: number, message: string) => Promise<void>;
}

/* -------------------------------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------------------------------- */

export const FETCH_PROGRESS_TOTAL = 4;
const PROGRESS_NOTIFICATION_TIMEOUT_MS = 5000;

/* -------------------------------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------------------------------- */

function resolveRelatedTaskMeta(
  meta?: RequestMeta
): { taskId: string } | undefined {
  if (!meta) return undefined;
  const related = meta['io.modelcontextprotocol/related-task'];
  if (!isObject(related)) return undefined;
  const { taskId } = related as { taskId?: unknown };
  return typeof taskId === 'string' ? { taskId } : undefined;
}

/* -------------------------------------------------------------------------------------------------
 * Progress reporter
 * ------------------------------------------------------------------------------------------------- */

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
      return { report: async () => {} };
    }

    return new ToolProgressReporter(
      token,
      sendNotification,
      relatedTaskMeta,
      onProgress
    );
  }

  async report(progress: number, message: string): Promise<void> {
    if (this.isTerminal) return;
    const effectiveProgress = Math.max(progress, this.lastProgress);
    const isIncreasing = effectiveProgress > this.lastProgress;
    this.lastProgress = effectiveProgress;

    if (effectiveProgress >= FETCH_PROGRESS_TOTAL) {
      this.isTerminal = true;
    }
    if (this.onProgress) {
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

    await this.reportQueue;
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
