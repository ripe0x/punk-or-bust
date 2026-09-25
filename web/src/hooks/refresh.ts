// Tiny bus so a confirmed transaction can tell log scanners to poll now instead of waiting.
const listeners = new Set<() => void>();

export function onRefresh(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function requestRefresh(): void {
  for (const fn of listeners) fn();
}
