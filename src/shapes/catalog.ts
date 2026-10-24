// The shape types offered by the shape tool, in menu order, with their display names.
import type { TKey } from "../i18n";
import type { ShapeType } from "../model/types";

export const SHAPE_TYPES: readonly ShapeType[] = [
  "rectangle",
  "circle",
  "ellipse",
  "triangle",
  "diamond",
  "pentagon",
  "hexagon",
  "star",
  "polygon",
  "line",
  "arrow",
];

/** Catalogue key of each shape's display name. */
export const SHAPE_LABEL_KEY = {
  rectangle: "shapes.rectangle",
  circle: "shapes.circle",
  ellipse: "shapes.ellipse",
  triangle: "shapes.triangle",
  line: "shapes.line",
  arrow: "shapes.arrow",
  diamond: "shapes.diamond",
  pentagon: "shapes.pentagon",
  hexagon: "shapes.hexagon",
  star: "shapes.star",
  polygon: "shapes.polygon",
} as const satisfies Record<ShapeType, TKey>;
