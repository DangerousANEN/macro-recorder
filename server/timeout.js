// Minimal hard-timeout helper for macro execution
// Node 18+ / modern browsers: uses AbortController for cancellation signals

export class HardTimeoutError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'HardTimeoutError';
    this.details = details;
  }
}

export function createHardTimeout(ms, label = 'operation') {
  const controller = new AbortController();
  let timer = null;
  const start = Date.now();

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new HardTimeoutError(`Hard timeout after ${ms}ms (${label})`, {
        ms,
        label,
        elapsedMs: Date.now() - start
      }));
      reject(controller.signal.reason);
    }, ms);
    // Don't keep Node alive just because of the timer
    timer.unref?.();
  });

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  return { controller, signal: controller.signal, timeoutPromise, clear, startedAt: start };
}
