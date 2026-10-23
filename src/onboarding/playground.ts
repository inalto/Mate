// The Playground: a book with one page and a hint text box, created once (idempotent through
// `settings.playgroundPageId`) so first-timers have somewhere to try the tools.
import { upsertElements } from "../ipc/elements";
import { PAGE_MODE_SIDE_MARGIN, PAGE_MODE_TOP_MARGIN } from "../model/constants";
import type { TextBoxContent } from "../model/content";
import type { Element } from "../model/types";
import { useNotebookStore } from "../stores/notebook";
import { useSettingsStore } from "../stores/settings";
import { esc } from "../export/svgUtil";
import { sanitizeHtml } from "../text/sanitize";
import { defaultTextAttributes } from "../text/textBox";

export const PLAYGROUND_TEXT = "Try the pen (P), highlighter (H), eraser (E)… Press ? for shortcuts.";

function hintBox(pageId: string): Element {
  const attrs = defaultTextAttributes();
  const now = new Date().toISOString();
  const content: TextBoxContent = {
    contentHtml: sanitizeHtml(`<p>${esc(PLAYGROUND_TEXT)}</p>`),
    rawContent: PLAYGROUND_TEXT,
    textAttributes: attrs,
  };
  return {
    id: crypto.randomUUID(),
    pageId,
    type: "text-box",
    points: [{ x: PAGE_MODE_SIDE_MARGIN, y: PAGE_MODE_TOP_MARGIN, pressure: 0.5, timestamp: 0 }],
    color: attrs.color,
    width: 1,
    isHighlighter: false,
    boxWidth: 600,
    boxHeight: 90,
    content,
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
}

let inFlight: Promise<string> | null = null;

/** The Playground page id: the stored page when it still exists (not trashed), else a new one. */
export function ensurePlayground(): Promise<string> {
  inFlight ??= run().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function run(): Promise<string> {
  const nb = useNotebookStore.getState();
  if (!nb.loaded) await nb.load();
  const stored = useSettingsStore.getState().settings.playgroundPageId;
  if (stored && useNotebookStore.getState().tree.pages.some((p) => p.id === stored && !p.deletedAt)) return stored;

  const unit = await useNotebookStore.getState().createUnit("Playground");
  const { tree } = useNotebookStore.getState();
  const section = tree.sections.find((s) => s.unitId === unit.id);
  const page = section && tree.pages.find((p) => p.sectionId === section.id);
  if (!page) throw new Error("Could not create the Playground page.");
  await useNotebookStore.getState().rename("page", page.id, "Playground");
  await upsertElements([hintBox(page.id)]);
  await useSettingsStore.getState().update({ playgroundPageId: page.id });
  return page.id;
}
