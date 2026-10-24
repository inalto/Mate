import type { TKey } from "../../i18n";

export interface NavSection {
  id: string;
  titleKey: TKey;
}

export interface NavGroup {
  id: string;
  titleKey: TKey;
  sections: NavSection[];
}

/** Left-hand navigation: groups of sections, in display order. */
export const NAV_GROUPS: NavGroup[] = [
  { id: "general", titleKey: "settings.nav.groups.general", sections: [{ id: "general", titleKey: "settings.nav.sections.general" }] },
  {
    id: "appearance",
    titleKey: "settings.nav.groups.appearance",
    sections: [
      { id: "theme", titleKey: "settings.nav.sections.theme" },
      { id: "paper", titleKey: "settings.nav.sections.paper" },
    ],
  },
  {
    id: "writing",
    titleKey: "settings.nav.groups.writing",
    sections: [
      { id: "pen", titleKey: "settings.nav.sections.pen" },
      { id: "pen-buttons", titleKey: "settings.nav.sections.penButtons" },
      { id: "gestures", titleKey: "settings.nav.sections.gestures" },
    ],
  },
  {
    id: "intelligence",
    titleKey: "settings.nav.groups.intelligence",
    sections: [
      { id: "tutor", titleKey: "settings.nav.sections.tutor" },
      { id: "tutor-interactions", titleKey: "settings.nav.sections.tutorInteractions" },
      { id: "math-engines", titleKey: "settings.nav.sections.mathEngines" },
    ],
  },
  {
    id: "system",
    titleKey: "settings.nav.groups.system",
    sections: [
      { id: "shortcuts", titleKey: "settings.nav.sections.shortcuts" },
      { id: "trash", titleKey: "settings.nav.sections.trash" },
      { id: "backup", titleKey: "settings.nav.sections.backup" },
      { id: "sharing", titleKey: "settings.nav.sections.sharing" },
      { id: "updates", titleKey: "settings.nav.sections.updates" },
      { id: "about", titleKey: "settings.nav.sections.about" },
    ],
  },
];
