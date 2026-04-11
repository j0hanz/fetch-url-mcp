// Area contract: HTTP transport surface for auth, gateway, and rate limiting.
// Export only HTTP-facing primitives used outside http/; keep generic shared utilities and fetch logic out.

export * from './auth.js';
export * from './helpers.js';
export * from './native.js';
export * from './rate-limit.js';
