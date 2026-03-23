import { setTimeout as setTimeoutPromise } from 'node:timers/promises';

import { logError, logWarn } from './core.js';
import { getErrorMessage, isObject } from './utils.js';

/* -------------------------------------------------------------------------------------------------
 * Progress reporting
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
  canReportProgress?: () => boolean;
}

export interface ProgressReporter {
  report: (progress: number, message: string) => void;
}

const DEFAULT_PROGRESS_TOTAL = 8;
const PROGRESS_NOTIFICATION_TIMEOUT_MS = 5000;

function resolveRelatedTaskMeta(
  meta?: RequestMeta
): { taskId: string } | undefined {
  const related = meta?.['io.modelcontextprotocol/related-task'];
  if (!isObject(related)) return undefined;
  const { taskId } = related as { taskId?: unknown };
  return typeof taskId === 'string' ? { taskId } : undefined;
}

class ToolProgressReporter implements ProgressReporter {
  private isTerminal = false;
  private lastProgress = -1;
  private lastMessage?: string;
  private pendingNotification: ProgressNotification | undefined;
  private isDispatching = false;

  private constructor(
    private readonly token: ProgressToken | null,
    private readonly handlers: {
      send: ((notification: ProgressNotification) => Promise<void>) | undefined;
      onProgress: ((progress: number, message: string) => void) | undefined;
      canReport: (() => boolean) | undefined;
    },
    private readonly taskMeta?: { taskId: string }
  ) {}

  static create(extra: ToolHandlerExtra = {}): ProgressReporter {
    const token = extra._meta?.progressToken ?? null;
    const { onProgress } = extra;

    if (token === null && !onProgress) {
      return { report: () => {} };
    }

    return new ToolProgressReporter(
      token,
      {
        send: extra.sendNotification,
        onProgress,
        canReport: extra.canReportProgress,
      },
      resolveRelatedTaskMeta(extra._meta)
    );
  }

  /**
   * Report progress toward completion. Steps are monotonic (never decrease)
   * and may be skipped under normal conditions (e.g., fast responses skip
   * intermediate steps). Clients should treat progress as "at least this far"
   * rather than expecting every step to fire sequentially.
   */
  report(progress: number, message: string): void {
    if (this.isTerminal || this.handlers.canReport?.() === false) return;

    const effectiveProgress = Math.max(progress, this.lastProgress);
    const isIncreasing = effectiveProgress > this.lastProgress;
    const isMessageChanged = message !== this.lastMessage;

    this.lastProgress = effectiveProgress;
    this.lastMessage = message;

    if (effectiveProgress >= DEFAULT_PROGRESS_TOTAL) {
      this.isTerminal = true;
    }

    if (isIncreasing || isMessageChanged) {
      try {
        this.handlers.onProgress?.(effectiveProgress, message);
      } catch (error: unknown) {
        logError('Progress callback failed', {
          error: getErrorMessage(error),
          progress: effectiveProgress,
          message,
        });
      }
    }

    if (!isIncreasing || this.token === null || !this.handlers.send) return;

    this.pendingNotification = this.createProgressNotification(
      this.token,
      effectiveProgress,
      message
    );
    this.flushNotifications();
  }

  private flushNotifications(): void {
    if (this.isDispatching || !this.handlers.send) return;
    this.isDispatching = true;

    void (async (): Promise<void> => {
      try {
        while (this.pendingNotification) {
          if (this.handlers.canReport?.() === false) {
            this.pendingNotification = undefined;
            return;
          }

          const notification = this.pendingNotification;
          this.pendingNotification = undefined;
          await this.sendWithTimeout(notification);
        }
      } finally {
        this.isDispatching = false;
      }
    })();
  }

  private async sendWithTimeout(
    notification: ProgressNotification
  ): Promise<void> {
    if (!this.handlers.send) return;

    const ac = new AbortController();
    const timeoutPromise = setTimeoutPromise(
      PROGRESS_NOTIFICATION_TIMEOUT_MS,
      { timeout: true as const },
      { signal: ac.signal, ref: false }
    ).catch((err: unknown) => {
      if ((err as Error).name === 'AbortError') return { ok: true as const };
      throw err;
    });

    try {
      const outcome = await Promise.race([
        this.handlers.send(notification).then(() => {
          ac.abort();
          return { ok: true as const };
        }),
        timeoutPromise,
      ]);

      if ('timeout' in outcome) {
        logWarn('Progress notification timed out', {
          progress: notification.params.progress,
          message: notification.params.message,
        });
      }
    } catch (error: unknown) {
      logWarn('Failed to send progress notification', {
        error: getErrorMessage(error),
        progress: notification.params.progress,
        message: notification.params.message,
      });
    }
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
        total: DEFAULT_PROGRESS_TOTAL,
        message,
        ...(this.taskMeta && {
          _meta: {
            'io.modelcontextprotocol/related-task': this.taskMeta,
          },
        }),
      },
    };
  }
}

export const createProgressReporter = (
  extra?: ToolHandlerExtra
): ProgressReporter => ToolProgressReporter.create(extra);
