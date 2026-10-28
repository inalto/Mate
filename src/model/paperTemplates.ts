// The ordered page templates and their i18n labels: one list for the paper picker,
// the Page settings dialog and the Settings → Paper section.
import type { TKey } from "../i18n";
import type { BackgroundType } from "./types";

export const PAPER_TEMPLATES: [BackgroundType, TKey][] = [
  ["blank", "settings.paper.background.blank"],
  ["ruled", "settings.paper.background.ruled"],
  ["ruled-no-margin", "settings.paper.background.ruledNoMargin"],
  ["grid", "settings.paper.background.grid"],
  ["grid-uniform", "settings.paper.background.gridUniform"],
  ["dot-grid", "settings.paper.background.dotGrid"],
  ["isometric", "settings.paper.background.isometric"],
  ["hex", "settings.paper.background.hex"],
  ["cornell", "settings.paper.background.cornell"],
  ["handwriting", "settings.paper.background.handwriting"],
  ["columns", "settings.paper.background.columns"],
  ["music", "settings.paper.background.music"],
];
