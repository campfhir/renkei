# Retry with Backoff - Usage Guide

A production-ready retry mechanism for async operations with configurable backoff strategies.

## Quick Start

```typescript
import { retryWithBackoff } from '@/lib/retry-with-backoff';

// Simple usage with defaults (3 total attempts, exponential backoff)
const result = await retryWithBackoff(() => myAsyncOperation());
```

## Common Patterns

### LLM/API Calls (3 minutes timeout, exponential backoff)
```typescript
const result = await retryWithBackoff(
  () => llm.complete({ /* ... */ }),
  {
    timeout: 180_000,           // 3 minutes total
    maxRetries: 2,              // 3 total attempts
    backoffStrategy: 'exponential',
    backoffOffset: 2_000,       // 2s, 4s, 8s delays
    onRetry: (attempt, error, delay) => {
      logger.info(`LLM attempt ${attempt} failed, retrying in ${delay}ms`);
    }
  }
);
```

### Network Requests (30 seconds, linear backoff)
```typescript
const result = await retryWithBackoff(
  () => fetch(url),
  {
    timeout: 30_000,            // 30 seconds total
    maxRetries: 3,              // 4 total attempts
    backoffStrategy: 'linear',
    backoffOffset: 500,         // 500ms, 1s, 1.5s, 2s delays
  }
);
```

### Database Operations (10 seconds, exponential backoff)
```typescript
const result = await retryWithBackoff(
  () => db.query(sql),
  {
    timeout: 10_000,            // 10 seconds total
    maxRetries: 2,              // 3 total attempts
    backoffStrategy: 'exponential',
    backoffOffset: 100,         // 100ms, 200ms, 400ms delays
  }
);
```

### With Cancellation Support
```typescript
const controller = new AbortController();

// Start operation in background
const promise = retryWithBackoff(
  () => expensiveOperation(),
  {
    timeout: 60_000,
    maxRetries: 5,
    signal: controller.signal,
  }
);

// Cancel if needed
setTimeout(() => controller.abort(), 5000);

try {
  const result = await promise;
} catch (error) {
  if (error instanceof OperationAbortedError) {
    console.log('Operation was cancelled');
  }
}
```

## Configuration Reference

### Options Object

```typescript
interface RetryOptions {
  /**
   * Maximum total time for the operation including all retries (milliseconds).
   * Default: 180000 (3 minutes)
   */
  timeout?: number;

  /**
   * Maximum number of retry attempts after the initial attempt.
   * Total attempts = 1 + maxRetries
   * Default: 2 (so 3 total attempts)
   */
  maxRetries?: number;

  /**
   * Backoff strategy for retry delays.
   * - 'exponential': delay = offset * (2 ^ attemptNumber)
   * - 'linear': delay = offset * attemptNumber
   * Default: 'exponential'
   */
  backoffStrategy?: 'linear' | 'exponential';

  /**
   * Base delay in milliseconds for backoff calculation.
   * For exponential with offset=1000: 1s, 2s, 4s, 8s
   * For linear with offset=1000: 1s, 2s, 3s, 4s
   * Default: 1000
   */
  backoffOffset?: number;

  /**
   * Optional abort signal to cancel the operation at any time.
   */
  signal?: AbortSignal;

  /**
   * Optional callback invoked before each retry.
   * Useful for logging or metrics.
   */
  onRetry?: (attempt: number, error: Error, nextDelayMs: number) => void;
}
```

## Error Handling

### Success Case
```typescript
try {
  const result = await retryWithBackoff(fn);
  console.log('Success:', result);
} catch (error) {
  // Won't reach here if operation succeeds
}
```

### Retry Exhausted
```typescript
import { RetryExhaustedError } from '@/lib/retry-with-backoff';

try {
  const result = await retryWithBackoff(fn, { maxRetries: 2 });
} catch (error) {
  if (error instanceof RetryExhaustedError) {
    console.log(`Failed after ${error.attempts} attempts`);
    console.log(`Last error: ${error.lastError.message}`);
    console.log(`Error: ${error.message}`);
  }
}
```

### Operation Cancelled
```typescript
import { OperationAbortedError } from '@/lib/retry-with-backoff';

try {
  const result = await retryWithBackoff(fn, { signal: controller.signal });
} catch (error) {
  if (error instanceof OperationAbortedError) {
    console.log('Operation was aborted');
  }
}
```

## Backoff Strategy Examples

### Exponential (Default)
```
offset: 1000ms
Delays: 1000ms → 2000ms → 4000ms → 8000ms → 16000ms
Total: ~31 seconds for 5 attempts
```

### Linear
```
offset: 1000ms
Delays: 1000ms → 2000ms → 3000ms → 4000ms → 5000ms
Total: ~15 seconds for 5 attempts
```

## Monitoring & Logging

### With Detailed Logging
```typescript
const result = await retryWithBackoff(
  () => operation(),
  {
    timeout: 60_000,
    maxRetries: 3,
    onRetry: (attempt, error, delay) => {
      logger.warn(
        'Operation retry {attempt}: {error} (waiting {delay}ms)',
        {
          attempt,
          error: error.message,
          delay,
        }
      );
    },
  }
);
```

## Timeouts Explained

The timeout works in two ways:

### 1. **Overall Timeout**
- Measures from first attempt start to final result
- If exceeded, throws `RetryExhaustedError`

### 2. **Per-Attempt Timeout**
- Each individual attempt is capped at 60 seconds
- Prevents hanging on a single attempt
- Remaining time from overall timeout is used

Example:
```
timeout: 180000ms (3 minutes total)
Attempt 1: runs for up to 60s (if it takes 90s, fails)
  ↓ (if failed, retry)
Attempt 2: runs for up to 60s (total elapsed: 60s + delay)
  ↓ (if failed, retry)
Attempt 3: runs for remaining time up to 60s
  ↓
If still failing and time > 180s, throws RetryExhaustedError
```

## When NOT to Use

- **Idempotency not guaranteed**: Only retry if operation is safe to repeat
- **Connection pooling**: Already has built-in retry logic
- **User input operations**: Retrying creates confusing UX (user already waiting)
- **Critical operations**: Use explicit error handling instead

## Integration with Existing Code

### Before (No Retry)
```typescript
const completion = await llm.provider.complete(config);
```

### After (With Retry)
```typescript
const completion = await retryWithBackoff(
  () => llm.provider.complete(config),
  {
    timeout: 180_000,
    maxRetries: 2,
    backoffOffset: 2_000,
  }
);
```

## Performance Considerations

- **Initial attempt**: No delay, runs immediately
- **Backoff delays**: Exponential scales quickly (1s → 2s → 4s → 8s)
- **Timeout enforcement**: Checked before and during operation
- **Memory**: Minimal overhead per call (one timer per attempt)

## Testing

```typescript
import { vi } from 'vitest';
import { retryWithBackoff, RetryExhaustedError } from '@/lib/retry-with-backoff';

it('retries on failure', async () => {
  const fn = vi.fn()
    .mockRejectedValueOnce(new Error('fail'))
    .mockResolvedValueOnce('success');

  const result = await retryWithBackoff(fn, { timeout: 5000, maxRetries: 1 });
  
  expect(result).toBe('success');
  expect(fn).toHaveBeenCalledTimes(2);
});
```

## See Also

- `retry-with-backoff.ts` - Implementation details
- `retry-with-backoff.test.ts` - Test suite with more examples
