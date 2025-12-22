import type {
  FetchUrlsInput,
  ToolResponseBase,
} from '../../../config/types.js';

import { createToolErrorResponse } from '../../../utils/tool-error-handler.js';

export const MAX_URLS_PER_BATCH = 10;
export const DEFAULT_CONCURRENCY = 3;
export const MAX_CONCURRENCY = 5;

export function validateBatchInput(
  input: FetchUrlsInput
): string[] | ToolResponseBase {
  if (input.urls.length === 0) {
    return createToolErrorResponse(
      'At least one URL is required',
      '',
      'VALIDATION_ERROR'
    );
  }

  if (input.urls.length > MAX_URLS_PER_BATCH) {
    return createToolErrorResponse(
      `Maximum ${MAX_URLS_PER_BATCH} URLs allowed per batch`,
      '',
      'VALIDATION_ERROR'
    );
  }

  const validUrls = input.urls.filter(
    (url) => typeof url === 'string' && url.trim().length > 0
  );

  if (validUrls.length === 0) {
    return createToolErrorResponse(
      'No valid URLs provided',
      '',
      'VALIDATION_ERROR'
    );
  }

  return validUrls;
}
