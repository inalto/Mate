// An editor that is about to leave the page lets go of the focus and of its text selection first.
// iPadOS keeps drawing the caret and the selection grabbers (system chrome, in screen space) of an
// editable that is removed while it still holds them: they then stay on screen, detached from the
// page, until something else takes the selection.

/** Blur the focused element inside `root` and drop the document's selection when it lies in `root`. */
export function releaseTextFocus(root: HTMLElement): void {
  const doc = root.ownerDocument;
  const active = doc.activeElement;
  if (active instanceof HTMLElement && active !== doc.body && root.contains(active)) active.blur();
  const sel = doc.getSelection?.();
  if (!sel || sel.rangeCount === 0) return;
  if ((sel.anchorNode && root.contains(sel.anchorNode)) || (sel.focusNode && root.contains(sel.focusNode))) sel.removeAllRanges();
}
