// In-memory ring buffer of structured run events.
//
// The Player calls `recordEvent(runId, evt)` whenever it broadcasts a status
// update via WebSocket. The HTTP layer can then read those events via
// `getEvents(runId, since)` so an LLM agent (over MCP) can poll progress
// without subscribing to the WebSocket. Failures are also tracked in a
// dedicated buffer so `getLastFailure(runId)` is O(1).
//
// Memory is bounded: at most MAX_EVENTS per run, MAX_FAILURES failures, and
// run buffers are dropped automatically a few minutes after `markFinished`.

const MAX_EVENTS = 500;
const MAX_FAILURES = 50;
const RETENTION_MS = 5 * 60 * 1000; // 5 minutes after a run ends

const buffers = new Map(); // runId -> { events: [], failures: [], seq, finishedAt }
const FAILURE_TYPES = new Set([
  'click-failed',
  'fill-failed',
  'step-failed',
  'macro-failed',
  'assertion-failed',
  'extract-failed',
]);

function ensure(runId) {
  let b = buffers.get(runId);
  if (!b) {
    b = { events: [], failures: [], seq: 0, finishedAt: null };
    buffers.set(runId, b);
  }
  return b;
}

export function recordEvent(runId, evt) {
  if (!runId || !evt || typeof evt !== 'object') return;
  const b = ensure(runId);
  b.seq += 1;
  const stamped = { seq: b.seq, ts: Date.now(), ...evt };
  b.events.push(stamped);
  if (b.events.length > MAX_EVENTS) b.events.splice(0, b.events.length - MAX_EVENTS);
  if (FAILURE_TYPES.has(evt.type)) {
    b.failures.push(stamped);
    if (b.failures.length > MAX_FAILURES) b.failures.splice(0, b.failures.length - MAX_FAILURES);
  }
}

export function getEvents(runId, since = 0) {
  const b = buffers.get(runId);
  if (!b) return { events: [], seq: 0 };
  const events = since > 0 ? b.events.filter(e => e.seq > since) : b.events.slice();
  return { events, seq: b.seq };
}

export function getLastFailure(runId) {
  const b = buffers.get(runId);
  if (!b || b.failures.length === 0) return null;
  return b.failures[b.failures.length - 1];
}

export function getAllFailures(runId) {
  const b = buffers.get(runId);
  if (!b) return [];
  return b.failures.slice();
}

export function markFinished(runId) {
  const b = buffers.get(runId);
  if (!b) return;
  b.finishedAt = Date.now();
  setTimeout(() => {
    const cur = buffers.get(runId);
    if (cur && cur.finishedAt && Date.now() - cur.finishedAt >= RETENTION_MS) {
      buffers.delete(runId);
    }
  }, RETENTION_MS + 1000).unref?.();
}

export function dropRun(runId) {
  buffers.delete(runId);
}

// For tests / introspection.
export function _internalState() {
  const out = {};
  for (const [k, v] of buffers) out[k] = { events: v.events.length, failures: v.failures.length, seq: v.seq, finishedAt: v.finishedAt };
  return out;
}
