export function backoffDelay(attempt: number, baseMs = 1_000, maxMs = 30_000): number {
  const capped = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 6));
  const jitter = Math.floor(Math.random() * 400);
  return capped + jitter;
}
