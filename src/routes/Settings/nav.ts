export interface NavSection {
  id: string;
  title: string;
}

export interface NavGroup {
  id: string;
  title: string;
  sections: NavSection[];
}

/** Left-hand navigation: groups of sections, in display order. */
export const NAV_GROUPS: NavGroup[] = [
  { id: "general", title: "General", sections: [{ id: "general", title: "General" }] },
  {
    id: "appearance",
    title: "Appearance",
    sections: [
      { id: "theme", title: "Theme" },
      { id: "paper", title: "Paper & layout" },
    ],
  },
  {
    id: "writing",
    title: "Writing",
    sections: [
      { id: "pen", title: "Pen & stylus" },
      { id: "pen-buttons", title: "Pen buttons" },
      { id: "gestures", title: "Gestures & touch" },
    ],
  },
  {
    id: "intelligence",
    title: "Intelligence",
    sections: [
      { id: "tutor", title: "Tutor & recognition" },
      { id: "tutor-interactions", title: "Tutor interactions" },
    ],
  },
  {
    id: "system",
    title: "System",
    sections: [
      { id: "shortcuts", title: "Keyboard shortcuts" },
      { id: "trash", title: "Trash" },
      { id: "backup", title: "Backup" },
      { id: "sharing", title: "Sharing" },
      { id: "updates", title: "Updates" },
      { id: "about", title: "About" },
    ],
  },
];
