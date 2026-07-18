/**
 * timeout-helper — classify child_process errors as timeouts.
 *
 * Borrowed from Hermes `isTimeoutError` (covers Unix SIGTERM/SIGKILL
 * + Windows-specific ERR_CHILD_PROCESS_STDIO_MAXBUFFER). Used by
 * runRunCommand and any other tool that runs child_process.
 */

export interface ChildProcessError {
  code?: string;
  killed?: boolean;
  signal?: string;
  message?: string;
  name?: string;
}

export function isChildProcessTimeout(e: ChildProcessError | null | undefined): boolean {
  if (!e) return false;
  // Windows-specific: maxBuffer exceeded before timeout fired.
  if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return true;
  // Unix: child killed by our timeout.
  if (e.killed === true && (e.signal === 'SIGTERM' || e.signal === 'SIGKILL')) return true;
  // AbortController-driven abort (any platform): Node throws AbortError.
  if (e.name === 'AbortError') return true;
  return false;
}