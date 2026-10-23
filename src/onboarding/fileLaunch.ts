// Files the app was launched with (PDF Open-with, notebook files). A launch with a file target
// skips the welcome flow: the user came to open that file.
let seen = false;
const listeners = new Set<() => void>();

export function markFileLaunch(): void {
  seen = true;
  for (const l of [...listeners]) l();
}
export const hasFileLaunch = (): boolean => seen;
export function onFileLaunch(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
/** Test helper. */
export function resetFileLaunch(): void {
  seen = false;
  listeners.clear();
}
