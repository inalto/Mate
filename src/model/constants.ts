// Values mirror crates/mate-core/src/geometry.rs and settings.rs.
import type { AiProvider, AspectPreset, Settings } from "./types";

export const PAGE_WIDTH = 1080;
export const PAGE_HEIGHT = 1440;
export const PAGE_GAP = 24;
export const PAGE_BORDER_RADIUS = 12;
export const PAGE_MODE_TOP_MARGIN = 64;
export const PAGE_MODE_SIDE_MARGIN = 56;
export const PAGE_MODE_BOTTOM_MARGIN = 1200;

/** Portrait page height for each aspect preset (width is always PAGE_WIDTH). */
export const ASPECT_PRESET_HEIGHTS: Record<AspectPreset, number> = {
  a4: 1528,
  letter: 1397,
  "16:9": 1920,
  "4:3": 1440,
  square: 1080,
};

export const LIMITS = {
  MAX_ELEMENTS_PER_PAGE: 5000,
  MAX_POINTS_PER_STROKE: 50000,
} as const;

export const AI_PROVIDER_LABEL: Record<AiProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

/** Model used when `settings.aiModel` is empty (mirrors `ai::default_model` in Rust). */
export const AI_DEFAULT_MODEL: Record<AiProvider, string> = {
  anthropic: "claude-opus-5-5",
  openai: "gpt-5",
};

export const DEFAULT_SETTINGS: Settings = {
  settingsVersion: 1,
  theme: "light",
  handedness: "right",
  libraryView: "recent",
  sidebarLayout: "split",
  shortcutHintMode: "always",
  dismissedHints: {},
  invertImagesInDarkMode: true,
  staticSnapshotCache: true,
  showZoomIndicator: false,
  defaultPageMode: "canvas",
  defaultBackground: "ruled",
  alignTextToLines: true,
  defaultPageAspectRatio: "a4",
  defaultPageOrientation: "portrait",
  defaultPenColor: "#000000",
  defaultPenWidth: 4.11,
  defaultHighlighterColor: "#FDE047",
  defaultHighlighterWidth: 20.06,
  defaultTextColor: "#000000",
  defaultTextSize: 21.77,
  defaultShapeType: "rectangle",
  defaultShapeStrokeColor: "#000000",
  defaultShapeFillColor: "transparent",
  defaultShapeStrokeWidth: 2,
  defaultShapeFillOpacity: 1,
  defaultEraserType: "stroke",
  defaultEraserWidth: 20,
  eraserEraseShapes: true,
  eraserEraseImages: false,
  inkToShape: true,
  inkToShapeSnapsOnRelease: false,
  inkToShapeDwellMs: 750,
  scribbleToErase: true,
  scribbleEraseSensitivity: "standard",
  strokeStabilization: 35,
  fountainPenNibFlatness: 35,
  palmRejection: "high",
  snapToGrid: false,
  penBarrelButtonAction: "eraser",
  penEraserButtonAction: "eraser",
  scrollBehavior: "pan",
  pinchToZoom: true,
  drawWithFinger: false,
  conversionEnabled: true,
  correctnessMode: false,
  tutorUnderlineErrors: true,
  tutorShowChecking: true,
  tutorEnabled: true,
  tutorMode: "live",
  tutorDoubleTapAsk: true,
  tutorHoldToAsk: true,
  tutorVerdictChangeGate: "enforce",
  aiConsent: null,
  aiProvider: "anthropic",
  aiModel: "",
  analyticsConsent: false,
  trashRetentionDays: 30,
  defaultExportFormat: "pdf",
  recentColors: [],
  toolbarPresets: [
    { id: "preset-1", type: "pen", color: "#000000", width: 4.11 },
    { id: "preset-2", type: "pen", color: "#C62828", width: 4.11 },
    { id: "preset-3", type: "pen", color: "#1565C0", width: 4.11 },
    { id: "preset-4", type: "highlighter", color: "#FDE047", width: 20.06 },
    { id: "preset-5", type: "fountain-pen", color: "#000000", width: 4.11 },
  ],
};
