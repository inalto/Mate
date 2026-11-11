// The user's own swatches, shared by the colour pickers (settings.customSwatches): a click picks
// one, "+" saves a colour (the picker's current one when it has one, else the system colour
// dialog), and the "−" toggle turns clicks into removals.
import { Minus, Plus } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../stores/settings";
import { MAX_SWATCHES, withSwatch } from "./inkColors";

interface Props {
  /** The colour in use (its swatch is marked). */
  current?: string;
  /** The picker's working colour: "+" saves it. Without one, "+" opens the system colour dialog. */
  candidate?: string;
  onPick(color: string): void;
}

export default function CustomSwatches({ current, candidate, onPick }: Props) {
  const { t } = useTranslation();
  const swatches = useSettingsStore((s) => s.settings.customSwatches) ?? [];
  const [removing, setRemoving] = useState(false);
  const native = useRef<HTMLInputElement>(null);

  const save = (customSwatches: string[]) => {
    useSettingsStore
      .getState()
      .update({ customSwatches })
      .catch((err) => console.error("saving swatches failed", err));
  };
  const add = (color: string) => {
    const next = withSwatch(swatches, color);
    if (next !== swatches) save(next);
  };
  const remove = (color: string) => {
    const next = swatches.filter((c) => c !== color);
    save(next);
    if (next.length === 0) setRemoving(false);
  };

  return (
    <div className="tb-row swatch-shelf" role="group" aria-label={t("preset.swatches")}>
      {swatches.map((c) => (
        <button
          key={c}
          type="button"
          className={removing ? "tb-swatch removing" : current?.toUpperCase() === c.toUpperCase() ? "tb-swatch active" : "tb-swatch"}
          style={{ background: c }}
          aria-label={removing ? t("preset.removeSwatch", { color: c }) : t("library.colour", { color: c })}
          onClick={() => (removing ? remove(c) : onPick(c))}
        />
      ))}
      <button
        type="button"
        className="tb-btn swatch-tool"
        aria-label={t("preset.addSwatch")}
        title={t("preset.addSwatch")}
        disabled={swatches.length >= MAX_SWATCHES}
        onClick={() => (candidate ? add(candidate) : native.current?.click())}
      >
        <Plus size={14} />
      </button>
      {swatches.length > 0 && (
        <button
          type="button"
          className={removing ? "tb-btn swatch-tool active" : "tb-btn swatch-tool"}
          aria-label={t("preset.editSwatches")}
          title={t("preset.editSwatches")}
          aria-pressed={removing}
          onClick={() => setRemoving((r) => !r)}
        >
          <Minus size={14} />
        </button>
      )}
      <input
        ref={native}
        type="color"
        className="swatch-native"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const c = e.target.value.toUpperCase();
          add(c);
          onPick(c);
        }}
      />
    </div>
  );
}
