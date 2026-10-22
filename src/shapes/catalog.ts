// The shape types offered by the shape tool, in menu order, with their display names.
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

export const SHAPE_LABEL: Record<ShapeType, string> = {
  rectangle: "Rectangle",
  circle: "Circle",
  ellipse: "Ellipse",
  triangle: "Triangle",
  line: "Line",
  arrow: "Arrow",
  diamond: "Diamond",
  pentagon: "Pentagon",
  hexagon: "Hexagon",
  star: "Star",
  polygon: "Polygon",
};
