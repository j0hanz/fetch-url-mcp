# Implementation Plan for MCP Playwright Improvements

## Phase 1: Critical Security & Bug Fixes (Week 1)

**Priority**: 🔴 CRITICAL | **Estimated Effort**: 3-4 days | **Risk**: High if delayed

### Issue 1.1: TOCTOU Vulnerability in File Upload Validation

**File**: security.ts
**Estimated Effort**: 4-6 hours

#### Steps

1. Modify `validateUploadPath()` to use file descriptors instead of path-based checks
2. Add `/proc/self/fd/` fallback for systems without symlink support (Windows compatibility)
3. Ensure file handle closure in finally block
4. Add unit tests for symlink race condition scenarios
5. Update security documentation

#### Implementation Details

- Use `fs.open()` with `O_RDONLY` flag before any validation
- Perform all checks (realpath, size, type) using the file descriptor
- Close file handle in finally block
- Test on Windows (different `/proc` handling), Linux, macOS

#### Dependencies

- None (self-contained change)

#### Validation

```typescript
// Test case: Symlink race condition
test('prevents TOCTOU attacks via symlink manipulation', async () => {
  const validPath = path.join(ALLOWED_UPLOAD_DIR, 'test.txt');
  const maliciousPath = path.join(ALLOWED_UPLOAD_DIR, 'symlink.txt');

  // Create file and symlink
  await fs.writeFile(validPath, 'safe content');
  await fs.symlink('/etc/passwd', maliciousPath);

  // Should reject symlink pointing outside upload dir
  await expect(validateUploadPath(maliciousPath)).rejects.toThrow(
    'Symlink points outside'
  );
});
```

---

### Issue 1.2: Error Swallowing in Page Title Retrieval

**File**: page-operations.ts
**Estimated Effort**: 2-3 hours

#### Steps

1. Replace generic catch with error categorization logic
2. Use `toError()` utility to normalize errors
3. Differentiate expected errors (closed/detached) from unexpected errors
4. Use appropriate log levels: `info` for expected, `warn` for unexpected
5. Add stack traces for unexpected errors

#### Implementation Details

- Check error message for known patterns: `'closed'`, `'detached'`, `'target'`
- Provide semantic fallback values: `'<closed>'` vs `'<error>'`
- Include `pageId` and `error.stack` in warn-level logs

#### Dependencies

- None

#### Validation

- Manual test: Close page mid-operation, verify info-level log
- Unit test: Mock page.title() to throw various errors

---

### Issue 1.3: Storage Clearing Silent Failures

**File**: page-operations.ts
**Estimated Effort**: 3-4 hours

#### Steps

1. Wrap storage clearing in structured result object
2. Differentiate SecurityError (expected) from other errors (unexpected)
3. Return detailed results: `{ cleared, restricted, failed }`
4. Update return type signature to include `storageResults`
5. Add logging for unexpected storage errors

#### Implementation Details

- Use `page.evaluate()` to return structured result per page
- Collect results array and aggregate statistics
- Update tool handler response to include storage details

#### Dependencies

- Update browser-tools.ts to handle new return structure

#### Validation

```typescript
test('categorizes storage clearing results correctly', async () => {
  // Test file:// URL (expected restriction)
  await page.goto('file:///path/to/file.html');
  const result = await resetSessionState(sessionId);
  expect(result.storageResults.restricted).toBeGreaterThan(0);

  // Test normal page (should succeed)
  await page.goto('https://example.com');
  const result2 = await resetSessionState(sessionId);
  expect(result2.storageResults.cleared).toBeGreaterThan(0);
});
```

---

## Phase 2: High-Priority Maintainability (Week 2)

**Priority**: 🟠 HIGH | **Estimated Effort**: 5-6 days | **Dependencies**: Phase 1

### Issue 2.1: Split interaction-tools.ts (956 lines)

**File**: interaction-tools.ts
**Estimated Effort**: 1 day

#### Steps

1. Create `src/server/handlers/interaction/` directory
2. Split into 6 focused files:
   - `click-tools.ts` (~150 lines) - element_click
   - `fill-tools.ts` (~150 lines) - element_fill
   - `hover-tools.ts` (~120 lines) - element_hover
   - `keyboard-tools.ts` (~100 lines) - keyboard_press, keyboard_type
   - `form-tools.ts` (~150 lines) - select_option, checkbox_set
   - `advanced-interaction-tools.ts` (~150 lines) - drag_and_drop, file_upload, focus, clear
3. Create index.ts barrel export
4. Update index.ts imports
5. Run tests to ensure no regressions

#### File Structure

```typescript
// interaction/click-tools.ts
export function registerClickTools(ctx: ToolContext): void {
  const { server, browserManager, createToolHandler } = ctx;

  server.registerTool('element_click', {
    /* ... */
  });
}

// interaction/index.ts
export { registerClickTools } from './click-tools.js';
export { registerFillTools } from './fill-tools.js';
// ... rest

export function registerInteractionTools(ctx: ToolContext): void {
  registerClickTools(ctx);
  registerFillTools(ctx);
  registerHoverTools(ctx);
  registerKeyboardTools(ctx);
  registerFormTools(ctx);
  registerAdvancedInteractionTools(ctx);
}
```

#### Dependencies

- None (pure refactoring)

#### Validation

- All existing tests pass
- `npm run type-check` passes
- `npm run lint` passes
- File line counts confirmed < 200

---

### Issue 2.2: Split advanced-tools.ts (782 lines)

**File**: advanced-tools.ts
**Estimated Effort**: 1 day

#### Steps

1. Create `src/server/handlers/advanced/` directory
2. Split into 6 files:
   - `tracing-tools.ts` (~120 lines)
   - `network-tools.ts` (~150 lines)
   - `har-tools.ts` (~100 lines)
   - `pdf-tools.ts` (~80 lines)
   - `console-tools.ts` (~100 lines)
   - `frame-tools.ts` (~120 lines)
3. Create index.ts barrel export
4. Update imports in index.ts
5. Verify all tools still registered correctly

#### Dependencies

- Same pattern as Issue 2.1

---

### Issue 2.3: Split schemas.ts (546 lines)

**File**: schemas.ts
**Estimated Effort**: 4-6 hours

#### Steps

1. Create `src/server/handlers/schemas/` directory
2. Split into logical groups:
   - `primitives.ts` - sessionId, pageId, timeout (~50 lines)
   - `browser.ts` - browserType, waitUntil, elementState (~80 lines)
   - `viewport.ts` - viewport, position, clip, geolocation (~60 lines)
   - `locators.ts` - ariaRole, locatorFilter, elementIndex (~100 lines)
   - `interactions.ts` - click, fill, hover options (~80 lines)
   - `assertions.ts` - assertion-specific schemas (~50 lines)
   - `annotations.ts` - Tool annotation constants (~40 lines)
   - `compositions.ts` - basePageInput, selectorInput, etc. (~60 lines)
3. Create index.ts with comprehensive re-exports
4. Update all handler imports to use `schemas/index.js`
5. Ensure no circular dependencies

#### File Organization

```typescript
// schemas/index.ts
export * from './primitives.js';
export * from './browser.js';
export * from './viewport.js';
export * from './locators.js';
export * from './interactions.js';
export * from './assertions.js';
export * from './annotations.js';
export * from './compositions.js';

// Backward compatibility
export // Re-export everything for handlers that use specific imports
 {};
```

#### Dependencies

- All handler files import from schemas

#### Validation

- `npm run type-check` (catch any broken imports)
- All tests pass
- Bundle size unchanged

---

### Issue 2.4: DRY Violation - Locator Resolution Logic

**File**: interaction-tools.ts
**Estimated Effort**: 6-8 hours

#### Steps

1. Create `src/server/handlers/interaction/locator-resolver.ts`
2. Implement `resolveAndExecute()` factory function
3. Create method mapping table for action × locator type
4. Refactor `element_click`, `element_hover`, `element_fill` to use resolver
5. Add unit tests for locator resolution logic
6. Verify all interaction tests pass

#### Implementation Pattern

```typescript
// locator-resolver.ts
interface LocatorConfig {
  sessionId: string;
  pageId: string;
  locatorType: string;
  value: string;
  role?: AriaRole;
  name?: string;
  exact?: boolean;
  index?: ElementIndex;
  roleOptions?: RoleFilterOptions;
}

type ActionType = 'click' | 'hover' | 'fill';

const ACTION_METHOD_MAP: Record<string, Record<ActionType, string | null>> = {
  role: { click: 'clickByRole', hover: 'hoverByRole', fill: null },
  text: { click: 'clickByText', hover: 'hoverByText', fill: null },
  label: { click: null, hover: null, fill: 'fillByLabel' },
  // ... complete mapping
};

export function resolveAndExecute<T>(
  actions: InteractionActions,
  action: ActionType,
  config: LocatorConfig,
  options: Record<string, unknown>
): Promise<T> {
  const methodName = ACTION_METHOD_MAP[config.locatorType]?.[action];
  if (!methodName) {
    throw new Error(`Unsupported: ${config.locatorType} for ${action}`);
  }

  const args = buildArgsForLocatorType(config, options);
  return (actions as any)[methodName](...args);
}
```

#### Dependencies

- Issue 2.1 (split interaction-tools first)

---

### Issue 2.5: Role Options Object Allocation in Hot Path

**File**: interaction-actions.ts
**Estimated Effort**: 3-4 hours

#### Steps

1. Create `filterDefinedOptions()` utility in src/utils/object-utils.ts
2. Pre-filter role options before passing to Playwright
3. Apply same pattern to all role-based methods (clickByRole, hoverByRole)
4. Add performance benchmark test
5. Verify no behavior changes

#### Implementation

```typescript
// utils/object-utils.ts
export function filterDefined<T extends Record<string, unknown>>(
  obj: T
): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([_, value]) => value !== undefined)
  ) as Partial<T>;
}

// In clickByRole:
const roleFilters = filterDefined({
  disabled,
  expanded,
  pressed,
  selected,
  checked,
  level,
  includeHidden,
});

const baseLocator = page.getByRole(role, {
  name,
  exact,
  ...roleFilters, // Only defined values
});
```

#### Dependencies

- None

---

### Issue 2.6: Empty Catch Blocks in Assertions

**File**: assertion-actions.ts
**Estimated Effort**: 4-5 hours

#### Steps

1. Update `assertLocator()` to categorize errors
2. Differentiate TimeoutError (expected) from unexpected errors
3. Add try-catch around `getActual()` for element disappearance
4. Add structured logging for unexpected errors
5. Update all assertion method callers (16 methods)
6. Add tests for error categorization

#### Implementation

```typescript
private async assertLocator<T>(/*...*/) {
  return this.executePageOperation(/*...*/, async (page) => {
    const locator = page.locator(selector);
    try {
      await assertFn(locator, timeout);
      return result(true, successData);
    } catch (error) {
      const err = toError(error);

      // Expected: assertion timeout or condition not met
      if (err.name === 'TimeoutError' || err.message.includes('expect.')) {
        try {
          return result(false, await getActual(locator));
        } catch (getError) {
          this.logger.warn('Element disappeared during assertion', {
            selector,
            error: toError(getError).message,
          });
          throw ErrorHandler.elementNotFound(selector, 'disappeared');
        }
      }

      // Unexpected errors
      this.logger.error('Unexpected assertion error', {
        operation,
        selector,
        error: err.message,
        stack: err.stack,
      });
      throw ErrorHandler.handlePlaywrightError(err);
    }
  }, { selector });
}
```

#### Dependencies

- None

---

### Issue 2.7: Security Blocklist Incomplete

**File**: security.ts
**Estimated Effort**: 3-4 hours

#### Steps

1. Add missing dangerous APIs to `STRICT_BLOCKLIST`
2. Group by category with comments
3. Add unit tests for each blocked API
4. Update security documentation
5. Consider creating allowlist instead of blocklist (safer)

#### New Blocklist Entries

```typescript
const STRICT_BLOCKLIST = [
  // ... existing entries

  // Web Crypto (side-channel attacks, fingerprinting)
  'crypto.subtle',
  'window.crypto.subtle',
  'SubtleCrypto',

  // WebAssembly (arbitrary code execution)
  'WebAssembly',
  'wasm',
  '.wasm',

  // Sensor APIs (privacy leaks, fingerprinting)
  'navigator.geolocation',
  'navigator.mediaDevices',
  'DeviceOrientationEvent',
  'DeviceMotionEvent',
  'DeviceProximityEvent',
  'AmbientLightSensor',
  'Accelerometer',
  'Gyroscope',
  'Magnetometer',

  // Payment APIs
  'PaymentRequest',
  'PaymentResponse',

  // Web Authentication (credential access)
  'navigator.credentials',
  'PublicKeyCredential',
  'CredentialsContainer',

  // Notification APIs
  'Notification',
  'navigator.notifications',
  'PushManager',

  // Modal dialogs (UX disruption)
  'window.alert',
  'window.confirm',
  'window.prompt',
  'window.showModalDialog',

  // Frame busting (clickjacking)
  'window.top',
  'window.parent',
  'window.frames',
  'window.opener',
];
```

#### Dependencies

- None

#### Validation

```typescript
test.describe('Security Blocklist', () => {
  for (const blocked of STRICT_BLOCKLIST) {
    test(`blocks ${blocked}`, async () => {
      const script = `return ${blocked}`;
      await expect(evaluateScript(page, script)).rejects.toThrow(
        'blocked operation'
      );
    });
  }
});
```

---

### Issue 2.8: Assertion Factory for Metaprogramming

**File**: assertion-actions.ts (503 lines)
**Estimated Effort**: 6-8 hours

#### Steps

1. Create assertion metadata registry with `LOCATOR_ASSERTIONS` and `PAGE_ASSERTIONS`
2. Implement generic `assertLocatorGeneric()` and `assertPageGeneric()` methods
3. Refactor 20 assertion methods to use factory pattern
4. Reduce file from 503 lines to ~200 lines
5. Ensure all assertion tests still pass
6. Update documentation

#### Implementation Pattern

```typescript
interface AssertionMetadata<T> {
  operation: string;
  assertFn: (target: Locator | Page, expected: T, timeout: number) => Promise<void>;
  getActual: (target: Locator | Page) => Promise<Record<string, unknown>>;
  successKey: string;
}

const LOCATOR_ASSERTIONS = {
  visible: {
    operation: 'Assert visible',
    assertFn: (loc, _, t) => expect(loc).toBeVisible({ timeout: t }),
    getActual: async (loc) => ({ visible: await loc.isVisible().catch(() => false) }),
    successKey: 'visible',
  },
  // ... 15 more locator assertions
} as const;

const PAGE_ASSERTIONS = {
  url: {
    operation: 'Assert URL',
    assertFn: (page, expected, t) => expect(page).toHaveURL(expected, { timeout: t }),
    getActual: (page) => Promise.resolve({ actualUrl: page.url() }),
    successKey: 'actualUrl',
  },
  // ... 4 more page assertions
} as const;

// Generic implementation
private async assertLocatorGeneric<T>(
  sessionId: string,
  pageId: string,
  selector: string,
  assertionType: keyof typeof LOCATOR_ASSERTIONS,
  expected: T,
  timeout?: number
) {
  const meta = LOCATOR_ASSERTIONS[assertionType];
  return this.assertLocator(
    sessionId, pageId, selector,
    meta.operation,
    (loc, t) => meta.assertFn(loc, expected, t),
    meta.getActual,
    { [meta.successKey]: expected },
    timeout
  );
}

// Public methods become one-liners
async assertVisible(sessionId: string, pageId: string, selector: string, options = {}) {
  return this.assertLocatorGeneric(sessionId, pageId, selector, 'visible', true, options.timeout);
}

async assertHidden(sessionId: string, pageId: string, selector: string, options = {}) {
  return this.assertLocatorGeneric(sessionId, pageId, selector, 'hidden', true, options.timeout);
}

async assertEnabled(sessionId: string, pageId: string, selector: string, options = {}) {
  return this.assertLocatorGeneric(sessionId, pageId, selector, 'enabled', true, options.timeout);
}
```

#### Dependencies

- Issue 2.6 (error handling improvements)

---

## Phase 3: Medium-Priority Improvements (Week 3)

**Priority**: 🟡 MEDIUM | **Estimated Effort**: 4-5 days

### Issue 3.1: Magic Numbers in Pagination

**File**: types.ts
**Estimated Effort**: 2-3 hours

#### Steps

1. Create `PAGINATION_LIMITS` constant object in constants.ts
2. Replace magic numbers with named constants
3. Update `normalizePageParams()` function
4. Add JSDoc explaining each limit
5. Update tests to use new constants

#### Implementation

```typescript
// utils/constants.ts
export const PAGINATION_LIMITS = {
  MIN_PAGE: 1,
  MIN_PAGE_SIZE: 1,
  DEFAULT_PAGE_SIZE: 10,
  MAX_PAGE_SIZE: 100,
} as const;

// types.ts
import { PAGINATION_LIMITS } from '../../utils/constants.js';

function normalizePageParams(params: PaginationParams) {
  return {
    page: Math.max(
      PAGINATION_LIMITS.MIN_PAGE,
      params.page ?? PAGINATION_LIMITS.MIN_PAGE
    ),
    pageSize: Math.min(
      PAGINATION_LIMITS.MAX_PAGE_SIZE,
      Math.max(
        PAGINATION_LIMITS.MIN_PAGE_SIZE,
        params.pageSize ?? PAGINATION_LIMITS.DEFAULT_PAGE_SIZE
      )
    ),
  };
}
```

#### Dependencies

- None

---

### Issue 3.2: Session List Caching

**File**: session-manager.ts
**Estimated Effort**: 4-5 hours

#### Steps

1. Add cache properties to SessionManager class
2. Implement TTL-based caching in `listSessions()`
3. Invalidate cache on `createSession()`, `deleteSession()`, `updateActivity()`
4. Add cache metrics to `getStatus()`
5. Add unit tests for cache behavior
6. Add performance benchmark test

#### Implementation

```typescript
export class SessionManager {
  private sessionListCache: SessionInfo[] | null = null;
  private cacheTimestamp = 0;
  private readonly CACHE_TTL = 1000; // 1 second
  private cacheHits = 0;
  private cacheMisses = 0;

  listSessions(): SessionInfo[] {
    const now = Date.now();
    if (this.sessionListCache && now - this.cacheTimestamp < this.CACHE_TTL) {
      this.cacheHits++;
      return this.sessionListCache;
    }

    this.cacheMisses++;
    this.sessionListCache = Array.from(this.sessions.values()).map(
      this.sessionToInfo
    );
    this.cacheTimestamp = now;
    return this.sessionListCache;
  }

  private invalidateCache(): void {
    this.sessionListCache = null;
  }

  createSession(options: SessionCreateOptions): string {
    // ... existing code
    this.invalidateCache();
    return sessionId;
  }

  deleteSession(sessionId: string): boolean {
    const deleted = this.sessions.delete(sessionId);
    if (deleted) this.invalidateCache();
    return deleted;
  }

  updateActivity(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.metadata.lastActivity = new Date();
      this.invalidateCache(); // Activity changes affect idleMs
    }
  }

  getCacheStats() {
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      hitRate: this.cacheHits / (this.cacheHits + this.cacheMisses),
    };
  }
}
```

#### Dependencies

- None

---

### Issue 3.3: checkLimit() Side Effect Naming

**File**: rate-limiter.ts
**Estimated Effort**: 2-3 hours

#### Steps

1. Rename `checkLimit()` to `consumeToken()`
2. Add new `canAccept()` method for read-only checks
3. Update all call sites in SessionManager
4. Update tests to use new method names
5. Update documentation

#### Implementation

```typescript
export class RateLimiter {
  /**
   * Consume a token from the rate limiter.
   * @throws {MCPPlaywrightError} If rate limit is exceeded
   */
  consumeToken(): void {
    const status = this.getStatus();

    if (!status.allowed) {
      throw ErrorHandler.rateLimitExceeded(
        this.maxRequests,
        Math.round(this.windowMs / 1000)
      );
    }

    this.timestamps.push(Date.now());
  }

  /**
   * Check if a request can be accepted without consuming a token (read-only).
   * @returns true if request would be allowed
   */
  canAccept(): boolean {
    this.pruneExpired();
    return this.timestamps.length < this.maxRequests;
  }
}

// In SessionManager:
checkRateLimit(): void {
  this.rateLimiter.consumeToken(); // Clear side effect
}
```

#### Dependencies

- None

---

### Issue 3.4: Retry with Custom Predicates

**File**: retry.ts
**Estimated Effort**: 3-4 hours

#### Steps

1. Add `shouldRetry` callback to `RetryOptions`
2. Implement predicate checking in `withRetry()`
3. Add common retry predicates as exports
4. Update interaction tools to use predicates for network errors
5. Add tests for retry predicate scenarios

#### Implementation

```typescript
export interface RetryOptions {
  retries: number;
  retryDelay: number;
  exponential?: boolean;
  maxDelay?: number;
  shouldRetry?: (error: Error, attempt: number) => boolean;
}

// Common predicates
export const RETRY_PREDICATES = {
  always: () => true,
  never: () => false,
  onTimeout: (error: Error) => error.name === 'TimeoutError',
  onNetwork: (error: Error) =>
    error.message.includes('net::') ||
    error.message.includes('ERR_CONNECTION') ||
    error.message.includes('ECONNREFUSED'),
  onTransient: (error: Error) =>
    RETRY_PREDICATES.onTimeout(error) || RETRY_PREDICATES.onNetwork(error),
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<RetryResult<T>> {
  const { shouldRetry = RETRY_PREDICATES.always, ...rest } = options;

  for (let attempt = 0; attempt <= rest.retries; attempt++) {
    try {
      const result = await fn();
      return { result, retriesUsed: attempt };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      if (attempt < rest.retries && shouldRetry(err, attempt)) {
        await sleep(currentDelay);
        if (rest.exponential) {
          currentDelay = Math.min(currentDelay * 2, rest.maxDelay ?? 30_000);
        }
      } else {
        throw err; // Not retryable or out of attempts
      }
    }
  }
}
```

#### Dependencies

- None

---

### Issue 3.5: generateRequestId() Testing

**File**: types.ts
**Estimated Effort**: 2-3 hours

#### Steps

1. Add dependency injection for request ID generation
2. Create setter/getter for custom generators
3. Update tests to use deterministic ID generation
4. Ensure production code unchanged
5. Add example test showing usage

#### Implementation

```typescript
export type RequestIdGenerator = () => string;

let requestIdGenerator: RequestIdGenerator = () => uuidv4().slice(0, 8);

export function generateRequestId(): string {
  return requestIdGenerator();
}

// For testing only
export function setRequestIdGenerator(generator: RequestIdGenerator): void {
  requestIdGenerator = generator;
}

export function resetRequestIdGenerator(): void {
  requestIdGenerator = () => uuidv4().slice(0, 8);
}

// In test files:
import { setRequestIdGenerator, resetRequestIdGenerator } from './types';

test.beforeEach(() => {
  let counter = 0;
  setRequestIdGenerator(() => `test-${++counter}`);
});

test.afterEach(() => {
  resetRequestIdGenerator();
});
```

#### Dependencies

- None

---

### Issue 3.6: manageTabs Type Safety

**File**: page-operations.ts
**Estimated Effort**: 3-4 hours

#### Steps

1. Create `TabAction` discriminated union type
2. Update `manageTabs()` signature to use union
3. Update handler call sites to pass structured actions
4. Add TypeScript tests (type-level assertions)
5. Update documentation

#### Implementation

```typescript
type TabAction =
  | { type: 'list' }
  | { type: 'create'; url?: string }
  | { type: 'close'; pageId: string }
  | { type: 'select'; pageId: string };

async manageTabs(
  sessionId: string,
  action: TabAction
): Promise<{
  success: boolean;
  tabs?: Array<{ pageId: string; title: string; url: string; active: boolean }>;
  newPageId?: string;
}> {
  const session = this.sessionManager.getSession(sessionId);

  switch (action.type) {
    case 'create':
      return this.createTab(sessionId, session, action.url);
    case 'close':
      return this.closeTab(sessionId, action.pageId);
    case 'select':
      return this.selectTab(sessionId, action.pageId);
    case 'list':
      return this.listTabs(session);
  }
}

// Update handler (browser-tools.ts):
const result = await browserManager.pageOperations.manageTabs(
  sessionId,
  action === 'close'
    ? { type: 'close', pageId: pageId! }
    : action === 'create'
    ? { type: 'create', url }
    : action === 'select'
    ? { type: 'select', pageId: pageId! }
    : { type: 'list' }
);
```

#### Dependencies

- Update browser-tools.ts

---

### Issue 3.7: Extract Role Resolution Logic

**File**: interaction-actions.ts
**Estimated Effort**: 2-3 hours

#### Steps

1. Create utility function `resolveRoleParams()`
2. Apply to all role-based methods (clickByRole, hoverByRole)
3. Add unit tests for role resolution edge cases
4. Update documentation

#### Implementation (see detailed fix in review)

#### Dependencies

- None

---

### Issue 3.8: Split Config Parsing Logic

**File**: server-config.ts (206 lines)
**Estimated Effort**: 4-5 hours

#### Steps

1. Create `src/config/parsers.ts` with parsing functions
2. Create `src/config/validators.ts` with validation logic
3. Create `src/config/defaults.ts` with constant defaults
4. Keep only config object construction in server-config.ts
5. Update imports and exports
6. Add unit tests for parsers

#### File Structure

```typescript
// config/parsers.ts
export const parsers = {
  number: (value: string | undefined, fallback: number, options?: MinMax) =>
    number,
  boolean: (value: string | undefined, fallback: boolean) => boolean,
  browser: (value: string | undefined) => BrowserType,
  logLevel: (value: string | undefined) => LogLevel,
  viewport: (
    width: string | undefined,
    height: string | undefined,
    fallback: Viewport
  ) => Viewport,
};

// config/defaults.ts
export const DEFAULT_VALUES = {
  LOG_LEVEL: 'info',
  MAX_SESSIONS: 5,
  BROWSER: 'chromium',
  HEADLESS: true,
  VIEWPORT: { width: 1366, height: 900 },
  // ... all defaults
} as const;

// config/server-config.ts (simplified)
import { parsers } from './parsers.js';
import { DEFAULT_VALUES } from './defaults.js';

export const config: ServerConfig = Object.freeze({
  logLevel: parsers.logLevel(process.env.LOG_LEVEL),
  maxConcurrentSessions: parsers.number(
    process.env.MAX_SESSIONS,
    DEFAULT_VALUES.MAX_SESSIONS,
    {
      min: 1,
      max: 20,
    }
  ),
  // ... rest using parsers
});
```

#### Dependencies

- None

---

## Phase 4: Low-Priority Polish (Week 4)

**Priority**: 🔵 LOW | **Estimated Effort**: 1-2 days

### Issue 4.1: Use textContent() Helper

**File**: advanced-tools.ts
**Estimated Effort**: 1 hour

#### Steps

1. Search for `{ type: 'text', text: ... }` patterns
2. Replace with `textContent(message)` import from types.ts
3. Run linter and fix any issues
4. Commit as style improvement

#### Dependencies

- None

---

### Issue 4.2: Add BaseAction Documentation

**File**: base-action.ts
**Estimated Effort**: 2-3 hours

#### Steps

1. Add comprehensive JSDoc to `BaseAction` class
2. Document `executePageOperation()` with examples
3. Add usage examples in class-level docstring
4. Document all protected methods
5. Generate TypeDoc documentation

#### Implementation

````typescript
/**
 * Base class for all Playwright action modules.
 *
 * Provides standardized infrastructure for page operations:
 * - Session and page retrieval with UUID validation
 * - Activity tracking (updates lastActivity timestamp)
 * - Timing and performance metrics
 * - Error handling with automatic Playwright error mapping
 *
 * ## Usage
 *
 * All action modules should extend this class:
 *
 * ```typescript
 * export class MyActions extends BaseAction {
 *   async myOperation(sessionId: string, pageId: string, options: Options) {
 *     return this.executePageOperation(
 *       sessionId,
 *       pageId,
 *       'My operation description',
 *       async (page) => {
 *         // Playwright operations on page
 *         await page.locator('.selector').click();
 *         return { success: true };
 *       },
 *       { metadata: 'optional' }
 *     );
 *   }
 * }
 * ```
 *
 * ## Benefits
 *
 * - Automatic error handling with context
 * - Consistent logging format
 * - Activity tracking for session timeout
 * - Performance timing
 *
 * @see {@link executePageOperation} for operation execution
 * @see {@link SessionManager} for session lifecycle
 */
export abstract class BaseAction {
  /**
   * Execute an operation on a page with standardized infrastructure.
   *
   * Handles:
   * - Session/page retrieval and validation
   * - Activity timestamp updates
   * - Performance timing
   * - Error mapping (Playwright → MCPPlaywrightError)
   * - Structured logging with metadata
   *
   * @template T - Return type of the operation
   * @param sessionId - Browser session UUID
   * @param pageId - Page UUID within the session
   * @param operation - Human-readable operation name (for logging)
   * @param fn - Async function receiving the Page object
   * @param meta - Optional metadata to include in logs (selector, options, etc.)
   * @returns Result of the operation
   * @throws {MCPPlaywrightError} If session/page not found or operation fails
   *
   * @example
   * ```typescript
   * return this.executePageOperation(
   *   sessionId,
   *   pageId,
   *   'Click button',
   *   async (page) => {
   *     await page.locator('button').click();
   *     return { success: true };
   *   },
   *   { selector: 'button', force: false }
   * );
   * ```
   */
  protected async executePageOperation<T>(
    sessionId: string,
    pageId: string,
    operation: string,
    fn: (page: Page) => Promise<T>,
    meta?: Record<string, unknown>
  ): Promise<T> {
    /* ... */
  }
}
````

#### Dependencies

- None

---

## Phase 5: Testing & Documentation (Ongoing)

### Issue 5.1: Add Security Test Suite

**Estimated Effort**: 1 day

#### Steps

1. Create `tests/security/` directory
2. Add tests for:
   - TOCTOU vulnerability prevention
   - Script blocklist coverage
   - URL protocol validation
   - File upload path traversal
   - Storage security restrictions
3. Add fuzzing tests for script evaluation
4. Document security testing approach

---

### Issue 5.2: Add Performance Benchmarks

**Estimated Effort**: 1 day

#### Steps

1. Create `tests/benchmarks/` directory
2. Add benchmarks for:
   - Session list caching effectiveness
   - Role option filtering overhead
   - Assertion method performance
   - Retry logic with different predicates
3. Set up CI performance tracking
4. Document performance baselines

---

### Issue 5.3: Update Architecture Documentation

**Estimated Effort**: 4-6 hours

#### Steps

1. Update copilot-instructions.md with new module structure
2. Add module dependency diagrams
3. Document refactoring patterns used
4. Update AGENTS.md with new file locations
5. Create migration guide for external users

---

## Implementation Timeline

| Week        | Phase   | Focus                         | Estimated Completion               |
| ----------- | ------- | ----------------------------- | ---------------------------------- |
| **Week 1**  | Phase 1 | Critical Security & Bugs      | 3 critical issues fixed            |
| **Week 2**  | Phase 2 | High-Priority Maintainability | 8 high-priority issues resolved    |
| **Week 3**  | Phase 3 | Medium-Priority Improvements  | 8 medium-priority issues addressed |
| **Week 4**  | Phase 4 | Low-Priority Polish           | 2 low-priority issues completed    |
| **Ongoing** | Phase 5 | Testing & Documentation       | Continuous integration             |

---

## Validation Checklist

After each phase:

- [ ] `npm run lint` passes with no errors
- [ ] `npm run type-check` passes with no errors
- [ ] `npm test` passes all tests
- [ ] `npm run build` succeeds
- [ ] Bundle size not significantly increased
- [ ] All existing tests pass without modification
- [ ] New tests added for changed functionality
- [ ] Documentation updated for API changes
- [ ] No performance regressions (benchmark comparison)
- [ ] Code coverage maintained or improved

---

## Risk Mitigation

### High-Risk Changes

1. **File Upload Validation (Issue 1.1)**: Test thoroughly on Windows, Linux, macOS
2. **Module Splitting (Issues 2.1, 2.2)**: Create feature branch, test all tools individually
3. **Assertion Factory (Issue 2.8)**: Comprehensive assertion test suite before refactor

### Rollback Plan

- Each issue implemented in separate git commits
- Feature flags for new patterns (if applicable)
- Maintain backward compatibility during transitions
- Create git tags before major refactors

---

## Success Metrics

| Metric              | Current                             | Target          | Measurement                 |
| ------------------- | ----------------------------------- | --------------- | --------------------------- |
| **Security Score**  | 7/10 (TOCTOU, incomplete blocklist) | 10/10           | No critical vulnerabilities |
| **File Size (max)** | 956 lines                           | < 300 lines     | All files under threshold   |
| **Code Coverage**   | ~75% (estimated)                    | > 85%           | Jest/Playwright coverage    |
| **Type Safety**     | Good (strict mode)                  | Excellent       | Zero `any` types            |
| **Performance**     | Baseline TBD                        | < 5% regression | Benchmark suite             |
| **Maintainability** | 6/10                                | 9/10            | Subjective + metrics        |

---

## Further Considerations

### Post-Implementation

1. **API Stability**: Version all public interfaces after refactoring
2. **Breaking Changes**: Document any breaking changes in CHANGELOG.md
3. **Migration Guide**: Provide upgrade path for external users
4. **Performance Monitoring**: Set up continuous performance tracking
5. **Security Audits**: Schedule quarterly security reviews

### Future Enhancements

1. Consider moving to monorepo structure for better modularity
2. Evaluate GraphQL API layer for complex queries
3. Implement request batching for multiple operations
4. Add OpenTelemetry instrumentation for observability
5. Create plugin system for custom actions/handlers
