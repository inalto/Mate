// The catalogue of toolbar items: every id of `layout.ts` with its label, icon and button.
import {
  ArrowsVertical,
  ChartLine,
  Code,
  Cursor,
  Eraser,
  EyeSlash,
  FilmSlate,
  FlowArrow,
  FrameCorners,
  HandPointing,
  ImageSquare,
  Lasso,
  LineSegment,
  MagnifyingGlass,
  MathOperations,
  Microphone,
  Note,
  Pen,
  PlusSquare,
  Presentation,
  Record,
  Shapes,
  Table,
  TextT,
  TreeStructure,
} from "@phosphor-icons/react";
import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import type { TKey } from "../i18n";
import type { ShortcutAction } from "../keys/actions";
import { DictateButton } from "../components/DictateButton";
import RecordButton from "../recording/RecordButton";
import CoversMenu from "../covers/CoversMenu";
import {
  AutoShapesToggle,
  CodeButton,
  ConnectorButton,
  EquationButton,
  EraserButton,
  FingerToggle,
  FrameButton,
  GraphButton,
  ImageButton,
  InsertSpaceButton,
  MediaButton,
  MindmapButton,
  NoteButton,
  PaperButton,
  PensBlock,
  PresentButton,
  RulerIcon,
  RulerToggle,
  ShapeButton,
  StraightToggle,
  TableButton,
  ToolButton,
  ZoomBlock,
} from "./buttons";
import InsertMenu from "./InsertMenu";
import type { ItemId } from "./layout";

type IconProps = { size?: number };

export interface ToolbarItem {
  id: ItemId;
  label: TKey;
  Icon: ComponentType<IconProps>;
  Button: ComponentType;
}

/** A cursor / lasso / text button: the label is translated where it renders. */
function tool(id: "cursor" | "lasso" | "text", action: ShortcutAction, label: TKey, Icon: typeof Cursor): ComponentType {
  return function Tool() {
    const { t } = useTranslation();
    return <ToolButton id={id} action={action} label={t(label)} Icon={Icon} />;
  };
}

export const ITEMS: Record<ItemId, ToolbarItem> = {
  pens: { id: "pens", label: "toolbar.items.pens", Icon: Pen, Button: PensBlock },
  covers: { id: "covers", label: "toolbar.items.covers", Icon: EyeSlash, Button: CoversMenu },
  cursor: { id: "cursor", label: "toolbar.select", Icon: Cursor, Button: tool("cursor", "tool.cursor", "toolbar.select", Cursor) },
  lasso: { id: "lasso", label: "toolbar.lasso", Icon: Lasso, Button: tool("lasso", "tool.lasso", "toolbar.lasso", Lasso) },
  eraser: { id: "eraser", label: "toolbar.eraser", Icon: Eraser, Button: EraserButton },
  shape: { id: "shape", label: "toolbar.shape", Icon: Shapes, Button: ShapeButton },
  connector: { id: "connector", label: "connector.tool", Icon: FlowArrow, Button: ConnectorButton },
  frame: { id: "frame", label: "frame.tool", Icon: FrameCorners, Button: FrameButton },
  text: { id: "text", label: "toolbar.text", Icon: TextT, Button: tool("text", "tool.text", "toolbar.text", TextT) },
  note: { id: "note", label: "note.tool", Icon: Note, Button: NoteButton },
  mindmap: { id: "mindmap", label: "mindmap.tool", Icon: TreeStructure, Button: MindmapButton },
  insertSpace: { id: "insertSpace", label: "toolbar.insertSpace", Icon: ArrowsVertical, Button: InsertSpaceButton },
  insert: { id: "insert", label: "toolbar.items.insert", Icon: PlusSquare, Button: InsertMenu },
  image: { id: "image", label: "toolbar.insertImage", Icon: ImageSquare, Button: ImageButton },
  media: { id: "media", label: "media.insert", Icon: FilmSlate, Button: MediaButton },
  table: { id: "table", label: "toolbar.insertTable", Icon: Table, Button: TableButton },
  code: { id: "code", label: "toolbar.insertCode", Icon: Code, Button: CodeButton },
  equation: { id: "equation", label: "toolbar.insertEquation", Icon: MathOperations, Button: EquationButton },
  graph: { id: "graph", label: "toolbar.insertGraph", Icon: ChartLine, Button: GraphButton },
  dictate: { id: "dictate", label: "toolbar.items.dictate", Icon: Microphone, Button: DictateButton },
  record: { id: "record", label: "toolbar.items.record", Icon: Record, Button: RecordButton },
  straight: { id: "straight", label: "toolbar.straightLines", Icon: LineSegment, Button: StraightToggle },
  ruler: { id: "ruler", label: "toolbar.ruler", Icon: RulerIcon, Button: RulerToggle },
  autoShapes: { id: "autoShapes", label: "toolbar.autoShapes", Icon: Shapes, Button: AutoShapesToggle },
  finger: { id: "finger", label: "toolbar.items.finger", Icon: HandPointing, Button: FingerToggle },
  present: { id: "present", label: "present.start", Icon: Presentation, Button: PresentButton },
  paper: { id: "paper", label: "toolbar.paper", Icon: Note, Button: PaperButton },
  zoom: { id: "zoom", label: "toolbar.items.zoom", Icon: MagnifyingGlass, Button: ZoomBlock },
};
