// "Test" on the recall view opens a page and wants its run to start once the page is there. The
// request waits here until the editor takes it. Only the latest request is kept, and opening any
// other page drops it, so a request nobody took cannot start a run on a later, unrelated open.
let pending: string | null = null;

export function requestRun(pageId: string): void {
  pending = pageId;
}

/** True once for the requested page, then cleared; taking another page drops the request. */
export function takeRun(pageId: string): boolean {
  const mine = pending === pageId;
  pending = null;
  return mine;
}
