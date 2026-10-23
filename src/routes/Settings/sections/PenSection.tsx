import { SHAPE_LABEL, SHAPE_TYPES } from "../../../shapes/catalog";
import { ColorRow, SelectRow, SettingsSection, SliderRow, SubTitle, ToggleRow } from "../rows";

const one = (v: number) => v.toFixed(1);

export default function PenSection() {
  return (
    <SettingsSection id="pen" title="Pen & stylus">
      <ColorRow k="defaultPenColor" label="Pen colour" />
      <SliderRow k="defaultPenWidth" label="Pen width" min={0.5} max={15.4} step={0.1} format={one} />
      <ColorRow k="defaultHighlighterColor" label="Highlighter colour" />
      <SliderRow k="defaultHighlighterWidth" label="Highlighter width" min={5} max={40} step={0.1} format={one} />
      <SliderRow
        k="strokeStabilization"
        label="Stroke stabilisation"
        hint="Smooths wobble; higher lags the pen slightly"
        min={0}
        max={100}
        step={1}
      />
      <SliderRow k="fountainPenNibFlatness" label="Fountain pen nib flatness" min={0} max={100} step={1} />
      <ToggleRow k="penHaptics" label="Pen haptics" hint="A small tap when the pen snaps or erases, where supported" />

      <SubTitle>Ink to shape and scribble</SubTitle>
      <ToggleRow k="inkToShape" label="Ink to shape" hint="Hold the pen still at the end of a stroke to turn it into a shape" />
      <ToggleRow k="inkToShapeSnapsOnRelease" label="Snap when lifting the pen" />
      <SliderRow k="inkToShapeDwellMs" label="Hold time" min={300} max={2000} step={50} format={(v) => `${v} ms`} />
      <ToggleRow k="scribbleToErase" label="Scribble to erase" hint="Scribble quickly over pen ink to erase it" />
      <SelectRow
        k="scribbleEraseSensitivity"
        label="Scribble sensitivity"
        options={[
          { value: "less", label: "Less" },
          { value: "standard", label: "Standard" },
          { value: "more", label: "More" },
        ]}
      />

      <SubTitle>Text defaults</SubTitle>
      <ColorRow k="defaultTextColor" label="Text colour" />
      <SliderRow k="defaultTextSize" label="Text size" min={8} max={72} step={0.5} format={one} />

      <SubTitle>Shape defaults</SubTitle>
      <SelectRow
        k="defaultShapeType"
        label="Shape type"
        options={SHAPE_TYPES.map((t) => ({ value: t as string, label: SHAPE_LABEL[t] }))}
      />
      <ColorRow k="defaultShapeStrokeColor" label="Shape stroke colour" />
      <ColorRow k="defaultShapeFillColor" label="Shape fill colour" />
      <SliderRow k="defaultShapeStrokeWidth" label="Shape width" min={0.5} max={20} step={0.5} format={one} />
      <SliderRow
        k="defaultShapeFillOpacity"
        label="Shape fill opacity"
        min={0}
        max={1}
        step={0.05}
        format={(v) => `${Math.round(v * 100)}%`}
      />

      <SubTitle>Eraser defaults</SubTitle>
      <SelectRow
        k="defaultEraserType"
        label="Eraser type"
        options={[
          { value: "stroke", label: "Whole stroke" },
          { value: "partial", label: "Partial" },
        ]}
      />
      <SliderRow k="defaultEraserWidth" label="Eraser width" min={4} max={100} step={1} />
      <ToggleRow k="eraserEraseShapes" label="Erase shapes" />
      <ToggleRow k="eraserEraseImages" label="Erase images" />
    </SettingsSection>
  );
}
