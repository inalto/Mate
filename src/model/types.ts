// Hand-written mirror of crates/mate-core model.rs, storage/notebook.rs and settings.rs.
// Keep field names and enum strings identical to the Rust serde output.

export type PageMode = "canvas" | "page";
export type PenStyle = "pen" | "highlighter" | "fountain-pen" | "pencil";
export type ElementType =
  | "stroke"
  | "shape"
  | "text"
  | "image"
  | "text-box"
  | "codespace"
  | "graph"
  | "slide"
  | "table";
export type BackgroundType =
  | "blank"
  | "ruled"
  | "ruled-no-margin"
  | "grid"
  | "grid-uniform"
  | "dot-grid"
  | "custom";
export type ShapeType =
  | "rectangle"
  | "circle"
  | "ellipse"
  | "triangle"
  | "line"
  | "arrow"
  | "diamond"
  | "pentagon"
  | "hexagon"
  | "star"
  | "polygon";
export type AspectPreset = "a4" | "letter" | "16:9" | "4:3" | "square";
export type EntityKind = "bookshelf" | "unit" | "section" | "page";

export interface Point {
  x: number;
  y: number;
  pressure: number;
  timestamp: number;
  tiltX?: number;
  tiltY?: number;
  width?: number;
}

export interface BackgroundConfig {
  type: BackgroundType;
  spacing: number;
  gridColor?: string;
  ruleInsetX?: number;
  offsetX?: number;
  dotRadius: number;
  customImageUrl?: string;
}

export interface Bookshelf {
  id: string;
  title: string;
  icon?: string;
  color?: string;
  order: number;
  isExpanded: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  version: number;
}

export interface Unit {
  id: string;
  title: string;
  icon?: string;
  color?: string;
  isFavourite: boolean;
  bookshelfId?: string;
  isExpanded: boolean;
  orderIndex: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  version: number;
}

export interface Section {
  id: string;
  unitId: string;
  title: string;
  color: string;
  icon?: string;
  orderIndex: number;
  isExpanded: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  version: number;
}

export interface Page {
  id: string;
  sectionId: string;
  parentId?: string;
  title: string;
  isExpanded: boolean;
  isFavourite: boolean;
  depth: number;
  mode: PageMode;
  backgroundConfig: BackgroundConfig;
  pageWidth?: number;
  pageHeight?: number;
  thumbnailVersion: number;
  icon?: string;
  orderIndex: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  version: number;
}

export interface Element {
  id: string;
  pageId: string;
  type: ElementType;
  points: Point[];
  color: string;
  width: number;
  height?: number;
  isHighlighter: boolean;
  penStyle?: PenStyle;
  imageUrl?: string;
  shapeType?: ShapeType;
  fillColor?: string;
  boxWidth?: number;
  boxHeight?: number;
  content?: unknown;
  classification?: unknown;
  uiGroupId?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  version: number;
  lastWriteId?: string;
}

export interface NotebookTree {
  bookshelves: Bookshelf[];
  units: Unit[];
  sections: Section[];
  pages: Page[];
}

export interface TrashItem {
  kind: EntityKind;
  id: string;
  title: string;
  deletedAt: string;
}

export type Theme = "light" | "dark" | "sepia" | "high-contrast";

export interface PenPreset {
  id: string;
  type: "pen" | "fountain-pen" | "highlighter";
  color: string;
  width: number;
  sharpness?: number;
}

export interface Settings {
  settingsVersion: number;
  theme: Theme;
  handedness: string;
  libraryView: string;
  sidebarLayout: string;
  shortcutHintMode: string;
  dismissedHints: Record<string, boolean>;
  invertImagesInDarkMode: boolean;
  staticSnapshotCache: boolean;
  showZoomIndicator: boolean;
  defaultPageMode: PageMode;
  defaultBackground: BackgroundType;
  alignTextToLines: boolean;
  defaultPageAspectRatio: string;
  defaultPageOrientation: string;
  defaultPenColor: string;
  defaultPenWidth: number;
  defaultHighlighterColor: string;
  defaultHighlighterWidth: number;
  defaultTextColor: string;
  defaultTextSize: number;
  defaultShapeType: ShapeType;
  defaultShapeStrokeColor: string;
  defaultShapeFillColor: string;
  defaultShapeStrokeWidth: number;
  defaultShapeFillOpacity: number;
  defaultEraserType: string;
  defaultEraserWidth: number;
  eraserEraseShapes: boolean;
  eraserEraseImages: boolean;
  inkToShape: boolean;
  inkToShapeSnapsOnRelease: boolean;
  inkToShapeDwellMs: number;
  scribbleToErase: boolean;
  scribbleEraseSensitivity: string;
  strokeStabilization: number;
  fountainPenNibFlatness: number;
  palmRejection: string;
  snapToGrid: boolean;
  penBarrelButtonAction: string;
  penEraserButtonAction: string;
  scrollBehavior: string;
  pinchToZoom: boolean;
  drawWithFinger: boolean;
  conversionEnabled: boolean;
  correctnessMode: boolean;
  tutorUnderlineErrors: boolean;
  tutorShowChecking: boolean;
  tutorEnabled: boolean;
  tutorDoubleTapAsk: boolean;
  tutorHoldToAsk: boolean;
  tutorVerdictChangeGate: string;
  aiConsent: boolean | null;
  analyticsConsent: boolean;
  trashRetentionDays: number;
  defaultExportFormat: string;
  recentColors: string[];
  toolbarPresets: PenPreset[];
}
