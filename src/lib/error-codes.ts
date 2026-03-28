export const SystemErrors = {
  EBLOCKED: 'EBLOCKED',
  ETIMEOUT: 'ETIMEOUT',
  EINVAL: 'EINVAL',
  ENODATA: 'ENODATA',
  EBADREDIRECT: 'EBADREDIRECT',
  EUNSUPPORTEDPROTOCOL: 'EUNSUPPORTEDPROTOCOL',
  FETCH_ERROR: 'FETCH_ERROR',
  ABORTED: 'ABORTED',
  QUEUE_FULL: 'queue_full',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
} as const;

export const ErrorCategory = {
  UPSTREAM_TIMEOUT: 'upstream_timeout',
  UPSTREAM_ABORTED: 'upstream_aborted',
  UPSTREAM_RATE_LIMITED: 'upstream_rate_limited',
  UPSTREAM_HTTP_ERROR: 'upstream_http_error',
  QUEUE_FULL: 'queue_full',
  FETCH_ERROR: 'fetch_error',
  VALIDATION_ERROR: 'validation_error',
  MCP_ERROR: 'mcp_error',
} as const;
