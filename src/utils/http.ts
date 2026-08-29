// Default ceiling for outbound HTTP we don't control. Node's global fetch has
// no timeout, so a stalled connection otherwise hangs the awaiting handler
// forever — which in a Discord event handler means the command silently never
// completes: no error, no reply, nothing in the logs.
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

// fetch() with a hard deadline. Rejects with a descriptive error on timeout so
// the caller's catch can report something useful instead of hanging.
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
