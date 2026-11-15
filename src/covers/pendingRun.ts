// "Test" on the recall view opens a page and wants its run to start once the page is there. The
// request waits here, by page id, until the editor takes it.
const pending = new Set<string>();

export function requestRun(pageId: string): void {
  pending.add(pageId);
}

/** True once for a requested page, then cleared. */
export function takeRun(pageId: string): boolean {
  return pending.delete(pageId);
}
