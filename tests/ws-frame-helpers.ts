// Shared by integration tests that read raw WS frames: expand a WS_BATCH
// frame ({code: 'WS_BATCH', message: '', result: {events: [...]}}) into its
// events, in order; plain frames pass through unchanged. Mirrors the
// frontend's expandWsBatchFrame (src/lib/events.ts) and the batch format
// defined in server/ws-bridge.ts.
export function expandWsFrame(frame: unknown): Array<Record<string, unknown>> {
  const obj =
    typeof frame === 'object' && frame !== null ? (frame as Record<string, unknown>) : null;
  if (obj?.code === 'WS_BATCH') {
    const result = obj.result as {events?: unknown} | null;
    if (result && Array.isArray(result.events)) {
      return result.events.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === 'object' && entry !== null,
      );
    }
  }
  return obj ? [obj] : [];
}
