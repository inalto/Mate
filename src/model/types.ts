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
  | "isometric"
  | "hex"
  | "cornell"
  | "handwriting"
  | "columns"
  | "music"
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
  /** The folder this one sits in; absent at the Library root. */
  parentId?: string;
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
  /** Provenance of an imported page (`source`, `sourcePageId`, `sourceFingerprint`). */
  importMetadata?: Record<string, unknown>;
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

/** A catalog id from Rust (`ai::catalog`), e.g. "anthropic", "ollama" or "custom". */
export type AiProvider = string;

/** Whether a provider can read handwriting (images). */
export type AiVision = "yes" | "dependsOnModel" | "no";

export type AiProviderGroup = "cloud" | "local" | "custom";
/** What a service costs (Rust `catalog::Cost`); worded by `ai.cost.<code>`. */
export type AiCost = "paid" | "paidLow" | "paidSomeFree" | "freeTier" | "freeLocal" | "depends";
/** Where checked notes go (Rust `catalog::Privacy`); worded by `ai.privacy.<code>` with the label. */
export type AiPrivacy = "sentTo" | "sentToAndMaker" | "textSentTo" | "local" | "custom";

/** One entry of the provider catalog (`list_ai_providers`). */
export interface AiProviderInfo {
  id: AiProvider;
  label: string;
  group: AiProviderGroup;
  needsKey: boolean;
  editableBaseUrl: boolean;
  defaultBaseUrl: string;
  defaultModel: string;
  vision: AiVision;
  canListModels: boolean;
  /** Where to get a key; empty when none. */
  keyUrl: string;
  cost: AiCost;
  privacy: AiPrivacy;
}

/** What the UI may know about the AI setup (the key itself never leaves Rust). */
export interface AiStatus {
  /** A key is stored (cloud), always (local), or an address is set (custom); never with a refused address. */
  configured: boolean;
  /** A non-empty key is stored for the provider. */
  hasKey: boolean;
  /** The effective address is on this computer or the local network (never for cloud services). */
  local: boolean;
  provider: AiProvider;
  model: string;
  consent: boolean;
  needsKey: boolean;
  vision: AiVision;
  /** The address in use (the override, or the provider's default). */
  baseUrl: string;
}

export type VerdictDomain = "arithmetic" | "algebra" | "calculus" | "geometry" | "trigonometry" | "physics" | "other";
export type ErrorNature = "slip" | "procedural" | "conceptual";
export type VerdictCode = "INCOMPLETE" | "OK" | "CONCEPTUAL" | "ARITHMETIC" | "ALGEBRA" | "CALCULUS";
export type VerdictKind = "math" | "diagram";

export type TutorMode = "live" | "onask";

export interface Transcription {
  kind: "text" | "code";
  text: string;
}

/** The tutor's verdict on one stroke group (Rust `ai::verdict::Verdict`). */
export interface Verdict {
  description: string;
  latex: string;
  /** true right, false wrong, null incomplete. */
  correct: boolean | null;
  domain: VerdictDomain;
  errorNature: ErrorNature | null;
  hint: string | null;
  explanation: string | null;
  nextSteps: string | null;
  focusSpan: string | null;
  illegible: boolean;
  transcription: Transcription | null;
  /** Computed in Rust from `correct`/`errorNature`/`domain`; ignored when sent. */
  code: VerdictCode;
  /** Computed in Rust from `latex`; ignored when sent. */
  kind: VerdictKind;
}

export interface GroupBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A persisted verdict for one stroke group (Rust `storage::Recognition`, verdict flattened). */
export interface Recognition extends Verdict {
  pageId: string;
  strokeGroupId: string;
  elementIds: string[];
  bounds: GroupBounds;
  /** When the group's ink was captured for the request (ms since the epoch, `Date.now()`). */
  capturedAt: number;
  source: "auto" | "user";
  /** The user set `correct` by hand ("Mark as correct"). */
  userOverride: boolean;
  provider: string;
  model: string;
  /** Stamped by Rust when empty. */
  createdAt: string;
  /** Always stamped by Rust. */
  updatedAt: string;
}

/** What `upsertRecognition` sends: `code`/`kind` are computed in Rust. */
export type RecognitionInput = Omit<Recognition, "code" | "kind">;

/** `stale`: the ink changed after capture, or a newer capture is stored; nothing was written. */
export type UpsertOutcome = "stored" | "stale";

/** One full-text match. Hits arrive best first. */
export interface SearchHit {
  pageId: string;
  strokeGroupId: string;
  /** Plain text; matched terms are wrapped in `SNIPPET_OPEN`/`SNIPPET_CLOSE` (src/ipc/recognition). */
  snippet: string;
  /** FTS5 bm25 score: lower is a better match. */
  rank: number;
}

export interface LearningEvent {
  /** Generated by Rust when empty or omitted. */
  id?: string;
  pageId: string;
  strokeGroupId?: string | null;
  /** e.g. "attempt", "hint_shown", "why_shown", "next_shown", "override", "ask", "erase", "edit". */
  kind: string;
  payload?: unknown;
  /** Stamped by Rust when empty or omitted. */
  createdAt?: string;
}

/** One finger on a touch screen: "auto" draws unless a stylus was seen in the last 2 s, "draw" always
 * draws, "pan" never draws (two fingers always pan/pinch). */
export type FingerAction = "auto" | "draw" | "pan";

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
  /** What one finger does on a touch screen (see `FingerAction`). */
  fingerAction: FingerAction;
  conversionEnabled: boolean;
  correctnessMode: boolean;
  tutorUnderlineErrors: boolean;
  tutorShowChecking: boolean;
  tutorEnabled: boolean;
  /** "live": check each group as it settles; "onask": only groups the user asks about. */
  tutorMode: TutorMode;
  tutorDoubleTapAsk: boolean;
  tutorHoldToAsk: boolean;
  tutorVerdictChangeGate: string;
  aiConsent: boolean | null;
  aiProvider: AiProvider;
  /** Empty means the provider's default model. */
  aiModel: string;
  /** Empty means the provider's default address; only used by local and custom providers. */
  aiBaseUrl: string;
  /** Wolfram|Alpha may be sent typed maths when the user asks. */
  wolframConsent: boolean;
  /** Interface language: "system" (follow the OS) or a supported code ("en", "it", …). */
  language: string;
  trashRetentionDays: number;
  defaultExportFormat: string;
  recentColors: string[];
  toolbarPresets: PenPreset[];
  /** Per-action key overrides; empty means all defaults. */
  keybindings: KeybindingOverride[];
  onboardingDone: boolean;
  lastSeenVersion: string;
  playgroundPageId: string | null;
  penHaptics: boolean;
  checkUpdatesOnStartup: boolean;
}

export interface KeybindingOverride {
  action: string;
  keys: string;
}
