import { useTranslation } from "react-i18next";
import { isWindowsPlatform } from "../../../canvas/haptics";
import { SHAPE_LABEL_KEY, SHAPE_TYPES } from "../../../shapes/catalog";
import { ColorRow, SelectRow, SettingsSection, SliderRow, SubTitle, ToggleRow } from "../rows";

const one = (v: number) => v.toFixed(1);

export default function PenSection() {
  const { t } = useTranslation();
  return (
    <SettingsSection id="pen" title={t("settings.nav.sections.pen")}>
      <ColorRow k="defaultPenColor" label={t("settings.pen.penColor")} />
      <SliderRow k="defaultPenWidth" label={t("settings.pen.penWidth")} min={0.5} max={15.4} step={0.1} format={one} />
      <ColorRow k="defaultHighlighterColor" label={t("settings.pen.highlighterColor")} />
      <SliderRow k="defaultHighlighterWidth" label={t("settings.pen.highlighterWidth")} min={5} max={40} step={0.1} format={one} />
      <SliderRow
        k="strokeStabilization"
        label={t("settings.pen.stabilization.label")}
        hint={t("settings.pen.stabilization.hint")}
        min={0}
        max={100}
        step={1}
      />
      <SliderRow k="fountainPenNibFlatness" label={t("settings.pen.nibFlatness")} min={0} max={100} step={1} />
      {isWindowsPlatform() && (
        <ToggleRow k="penHaptics" label={t("settings.pen.haptics.label")} hint={t("settings.pen.haptics.hint")} />
      )}

      <SubTitle>{t("settings.pen.inkToShapeTitle")}</SubTitle>
      <ToggleRow k="inkToShape" label={t("settings.pen.inkToShape.label")} hint={t("settings.pen.inkToShape.hint")} />
      <ToggleRow k="inkToShapeSnapsOnRelease" label={t("settings.pen.snapOnRelease")} />
      <SliderRow
        k="inkToShapeDwellMs"
        label={t("settings.pen.holdTime")}
        min={300}
        max={2000}
        step={50}
        format={(v) => t("settings.pen.milliseconds", { value: v })}
      />
      <ToggleRow
        k="scribbleToErase"
        label={t("settings.pen.scribbleToErase.label")}
        hint={t("settings.pen.scribbleToErase.hint")}
      />
      <SelectRow
        k="scribbleEraseSensitivity"
        label={t("settings.pen.scribbleSensitivity.label")}
        options={[
          { value: "less", label: t("settings.pen.scribbleSensitivity.less") },
          { value: "standard", label: t("settings.pen.scribbleSensitivity.standard") },
          { value: "more", label: t("settings.pen.scribbleSensitivity.more") },
        ]}
      />

      <SubTitle>{t("settings.pen.textTitle")}</SubTitle>
      <ColorRow k="defaultTextColor" label={t("settings.pen.textColor")} />
      <SliderRow k="defaultTextSize" label={t("settings.pen.textSize")} min={8} max={72} step={0.5} format={one} />

      <SubTitle>{t("settings.pen.shapeTitle")}</SubTitle>
      <SelectRow
        k="defaultShapeType"
        label={t("settings.pen.shapeType")}
        options={SHAPE_TYPES.map((s) => ({ value: s as string, label: t(SHAPE_LABEL_KEY[s]) }))}
      />
      <ColorRow k="defaultShapeStrokeColor" label={t("settings.pen.shapeStrokeColor")} />
      <ColorRow k="defaultShapeFillColor" label={t("settings.pen.shapeFillColor")} />
      <SliderRow k="defaultShapeStrokeWidth" label={t("settings.pen.shapeWidth")} min={0.5} max={20} step={0.5} format={one} />
      <SliderRow
        k="defaultShapeFillOpacity"
        label={t("settings.pen.shapeFillOpacity")}
        min={0}
        max={1}
        step={0.05}
        format={(v) => `${Math.round(v * 100)}%`}
      />

      <SubTitle>{t("settings.pen.eraserTitle")}</SubTitle>
      <SelectRow
        k="defaultEraserType"
        label={t("settings.pen.eraserType.label")}
        options={[
          { value: "stroke", label: t("settings.pen.eraserType.stroke") },
          { value: "partial", label: t("settings.pen.eraserType.partial") },
        ]}
      />
      <SliderRow k="defaultEraserWidth" label={t("settings.pen.eraserWidth")} min={4} max={100} step={1} />
      <ToggleRow k="eraserEraseShapes" label={t("settings.pen.eraseShapes")} />
      <ToggleRow k="eraserEraseImages" label={t("settings.pen.eraseImages")} />
    </SettingsSection>
  );
}
