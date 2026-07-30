/*
 * Shared types and helpers used by both the v2 (Fast42) and v3 (Fast42v3) clients.
 */

/** Refetch/refresh a token this many seconds before it actually expires. */
export const TOKEN_EXPIRY_BUFFER_S = 20

export enum Method {
  GET = 'GET',
  POST = 'POST',
  PUT = 'PUT',
  DELETE = 'DELETE',
  PATCH = 'PATCH',
}

export interface RetryConfig {
  /** Master switch for automatic retries. Default: true. */
  enabled?: boolean;
  /**
   * Maximum number of retries for 5xx server errors (per request).
   * When retries are enabled, 429 rate-limit responses are retried indefinitely, respecting Retry-After.
   * Default: 5.
   */
  maxServerErrorRetries?: number;
  /** Base delay in ms to wait before retrying a 5xx server error. Default: 30000. */
  serverErrorBackoff?: number;
  /** Delay in seconds to wait on a 429 when the Retry-After header is missing. Default: 1. */
  retryAfterFallback?: number;
  /** Maximum random extra delay in ms added to every retry wait (spreads out retries). Default: 10000. */
  jitter?: number;
}

/** Fills in the default retry settings for any values the caller left unset. */
export function resolveRetry(retry?: RetryConfig): Required<RetryConfig> {
  return {
    enabled: retry?.enabled ?? true,
    maxServerErrorRetries: retry?.maxServerErrorRetries ?? 5,
    serverErrorBackoff: retry?.serverErrorBackoff ?? 30000,
    retryAfterFallback: retry?.retryAfterFallback ?? 1,
    jitter: retry?.jitter ?? 10000,
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function parseOptions(options: { [key: string]: string } | undefined): string {
  let optionsString = ""
  if (!options) {
    return optionsString
  }
  let firstOption = true
  for (let [key, value] of Object.entries(options)) {
    if (firstOption) {
      optionsString += `?${key}=${value}`
      firstOption = false
    } else {
      optionsString += `&${key}=${value}`
    }
  }
  return optionsString
}

/**
 * Runs `job` and transparently retries it on rate-limit (429) and, optionally, server-error (5xx)
 * responses. The retry policy is identical for both API versions; what differs is the `job` each
 * client passes in (the v2 client routes every attempt through its Bottleneck limiter, the v3
 * client calls fetch directly since v3 has no rate limits).
 *
 * When retry.enabled is true, 429 responses are retried indefinitely, waiting for the duration of the Retry-After header
 * (falling back to retryAfterFallback seconds when absent). 5xx responses are retried up to maxServerErrorRetries times
 * when retryServerErrors is true. After exhausting the 5xx retries, the last response is returned so the caller can inspect it.
 *
 * A 401 is retried exactly once, after invoking `onUnauthorized` (which is expected to drop the cached
 * access token so the next attempt authenticates again). A token can be invalidated server-side before
 * our cached copy expires, and without this the stale token would keep being sent until its TTL lapses.
 * The single retry is deliberate: a genuinely revoked or unauthorized key still surfaces its 401 to the
 * caller instead of looping.
 */
export async function runWithRetry(
  retry: Required<RetryConfig>,
  retryServerErrors: boolean,
  job: () => Promise<Response>,
  onUnauthorized?: () => Promise<void> | void,
): Promise<Response> {
  let serverErrorRetries = 0
  let reauthenticated = false
  while (true) {
    const response: Response = await job()

    if (retry.enabled && response.status === 401 && onUnauthorized && !reauthenticated) {
      reauthenticated = true
      try {
        await onUnauthorized()
        continue
      } catch {
        // Re-authentication itself failed (dead key, token endpoint down, ...). Return the original
        // 401 rather than throwing, so callers' .ok/.status checks keep working as before.
        return response
      }
    }

    if (retry.enabled && response.status === 429) {
      const retryAfterHeader = parseInt(response.headers.get('retry-after') ?? '')
      const retryAfter = Number.isNaN(retryAfterHeader) ? retry.retryAfterFallback : retryAfterHeader
      await delay(retryAfter * 1000 + Math.random() * retry.jitter)
      continue
    }

    if (retry.enabled && retryServerErrors && response.status >= 500 && response.status < 600) {
      if (serverErrorRetries >= retry.maxServerErrorRetries) {
        return response
      }
      serverErrorRetries++
      await delay(retry.serverErrorBackoff + Math.random() * retry.jitter)
      continue
    }

    return response
  }
}
