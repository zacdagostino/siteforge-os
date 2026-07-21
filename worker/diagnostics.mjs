function redactText(value) {
  return value
    .replace(/\b(?:sk|sk-proj|sk-[a-z]+)-[a-zA-Z0-9_-]{12,}\b/g, '[redacted key]')
    .replace(/\bBearer\s+[a-zA-Z0-9._~-]+/gi, 'Bearer [redacted]');
}

function compactText(value, limit) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return redactText(value).replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function diagnosticText(value, limit = 480) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return redactText(value).replace(/\r\n?/g, '\n').trim().slice(0, limit);
}

export function createDiagnosticWriter({ writeEvent, writeSnapshot }) {
  const entries = [];
  let lastSnapshotAt = 0;
  let queue = Promise.resolve();

  async function flush(force = false) {
    if (!entries.length) return;
    if (!force && Date.now() - lastSnapshotAt < 5_000) return;
    lastSnapshotAt = Date.now();
    try {
      await writeSnapshot(entries);
    } catch {
      // Diagnostics must never become a new reason for a worker to stop.
    }
  }

  function record(input) {
    const entry = {
      at: new Date().toISOString(),
      scope: compactText(input.scope, 80) || 'worker',
      title: compactText(input.title, 180) || 'Worker diagnostic',
      status: input.status === 'failed' || input.status === 'warning' ? input.status : 'completed',
      detail: compactText(input.detail, 640),
      command: compactText(input.command, 500),
      stdout: diagnosticText(input.stdout, 6_000),
      stderr: diagnosticText(input.stderr, 6_000),
      durationMs:
        typeof input.durationMs === 'number'
          ? Math.max(0, Math.round(input.durationMs))
          : undefined,
      metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
    };
    entries.push(entry);
    if (entries.length > 240) entries.splice(0, entries.length - 240);
    queue = queue
      .then(async () => {
        await writeEvent('diagnostic', entry.title, entry);
        await flush(entry.status === 'failed');
      })
      .catch(() => undefined);
    return queue;
  }

  return {
    record,
    flush: (force = true) => {
      queue = queue.then(() => flush(force)).catch(() => undefined);
      return queue;
    },
  };
}
