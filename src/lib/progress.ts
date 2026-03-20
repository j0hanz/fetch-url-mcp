import { logWarn } from './core.js';
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
const FETCH_PROGRESS_TOTAL = 8;
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
  private isTerminal = false;
  private lastProgress = -1;
  private lastMessage: string | undefined;
  private pendingNotification: ProgressNotification | undefined;
  private isDispatching = false;

  private constructor(
    private readonly token: ProgressToken | null,
    private readonly sendNotification:
      | ((notification: ProgressNotification) => Promise<void>)
      | undefined,
    private readonly relatedTaskMeta: { taskId: string } | undefined,
    private readonly onProgress:
      | ((progress: number, message: string) => void)
      | undefined,
    private readonly canReportProgress: (() => boolean) | undefined
  ) {}

  static create(extra?: ToolHandlerExtra): ProgressReporter {
    const token = extra?._meta?.progressToken ?? null;
    const sendNotification = extra?.sendNotification;
    const relatedTaskMeta = resolveRelatedTaskMeta(extra?._meta);
    const onProgress = extra?.onProgress;
    const canReportProgress = extra?.canReportProgress;

    if (token === null && !onProgress) {
      return { report: () => {} };
    }

    return new ToolProgressReporter(
      token,
      sendNotification,
      relatedTaskMeta,
      onProgress,
      canReportProgress
    );
  }

  /**
   * Report progress toward completion. Steps are monotonic (never decrease)
   * and may be skipped under normal conditions (e.g., fast responses skip
   * intermediate steps). Clients should treat progress as "at least this far"
   * rather than expecting every step to fire sequentially.
   */
  report(progress: number, message: string): void {
    if (this.isTerminal) return;
    if (this.canReportProgress && !this.canReportProgress()) return;
    const effectiveProgress = Math.max(progress, this.lastProgress);
    const isIncreasing = effectiveProgress > this.lastProgress;
    const isMessageChanged = message !== this.lastMessage;
    this.lastProgress = effectiveProgress;
    this.lastMessage = message;

    if (effectiveProgress >= FETCH_PROGRESS_TOTAL) {
      this.isTerminal = true;
    }

    if ((isIncreasing || isMessageChanged) && this.onProgress) {
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

    this.pendingNotification = this.createProgressNotification(
      this.token,
      effectiveProgress,
      message
    );
    this.flushNotifications();
  }

  private flushNotifications(): void {
    if (this.isDispatching || !this.sendNotification) return;
    this.isDispatching = true;

    void (async (): Promise<void> => {
      try {
        while (this.pendingNotification) {
          if (this.canReportProgress && !this.canReportProgress()) {
            this.pendingNotification = undefined;
            return;
          }

          const notification = this.pendingNotification;
          this.pendingNotification = undefined;
          await this.sendWithTimeout(notification);
        }
      } finally {
        this.isDispatching = false;
        if (this.pendingNotification) {
          this.flushNotifications();
        }
      }
    })();
  }

  private async sendWithTimeout(
    notification: ProgressNotification
  ): Promise<void> {
    if (!this.sendNotification) return;

    let timeoutId: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<{ timeout: true }>((resolve) => {
      timeoutId = setTimeout(() => {
        resolve({ timeout: true });
      }, PROGRESS_NOTIFICATION_TIMEOUT_MS);
      timeoutId.unref();
    });

    try {
      const outcome = await Promise.race([
        this.sendNotification(notification).then(() => ({ ok: true as const })),
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
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
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
