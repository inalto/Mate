import type { ReactNode } from "react";
import AiSettings from "../components/AiSettings";
import type { BackgroundType, PageMode, ShapeType, Theme } from "../model/types";
import { SHAPE_LABEL, SHAPE_TYPES } from "../shapes/catalog";
import { useSettingsStore } from "../stores/settings";

const THEMES: Array<{ id: Theme; label: string }> = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "sepia", label: "Sepia" },
  { id: "high-contrast", label: "High contrast" },
];

const BACKGROUNDS: Array<{ id: BackgroundType; label: string }> = [
  { id: "blank", label: "Blank" },
  { id: "ruled", label: "Ruled" },
  { id: "ruled-no-margin", label: "Ruled (no margin)" },
  { id: "grid", label: "Grid" },
  { id: "grid-uniform", label: "Uniform grid" },
  { id: "dot-grid", label: "Dot grid" },
];

const ASPECTS = [
  { id: "a4", label: "A4" },
  { id: "letter", label: "Letter" },
  { id: "16:9", label: "16:9" },
  { id: "4:3", label: "4:3" },
  { id: "square", label: "Square" },
];

const RETENTION = [7, 14, 30, 60, 90, 0];

/** `<input type="color">` only takes #rrggbb; anything else (e.g. "transparent") shows `fallback`. */
const hexOr = (c: string, fallback: string): string => (/^#[0-9a-f]{6}$/i.test(c) ? c : fallback);

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="field">
      {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span className="field-label">{label}</span>}
      {children}
    </div>
  );
}

export default function Settings() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);

  return (
    <div className="screen">
      <div className="screen-header">
        <h1>Settings</h1>
      </div>

      <section className="settings-group">
        <h2 className="section-title">Theme</h2>
        <div className="theme-cards" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <label key={t.id} className="card theme-card">
              <input
                type="radio"
                name="theme"
                value={t.id}
                checked={settings.theme === t.id}
                onChange={() => void update({ theme: t.id })}
              />
              {t.label}
            </label>
          ))}
        </div>
      </section>

      <section className="settings-group">
        <h2 className="section-title">Paper &amp; layout defaults</h2>
        <Field label="Page mode" htmlFor="set-mode">
          <select
            id="set-mode"
            className="input"
            value={settings.defaultPageMode}
            onChange={(e) => void update({ defaultPageMode: e.target.value as PageMode })}
          >
            <option value="canvas">Infinite</option>
            <option value="page">Paper</option>
          </select>
        </Field>
        <Field label="Background" htmlFor="set-bg">
          <select
            id="set-bg"
            className="input"
            value={settings.defaultBackground}
            onChange={(e) => void update({ defaultBackground: e.target.value as BackgroundType })}
          >
            {BACKGROUNDS.map((b) => (
              <option key={b.id} value={b.id}>{b.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Page size" htmlFor="set-aspect">
          <select
            id="set-aspect"
            className="input"
            value={settings.defaultPageAspectRatio}
            onChange={(e) => void update({ defaultPageAspectRatio: e.target.value })}
          >
            {ASPECTS.map((a) => (
              <option key={a.id} value={a.id}>{a.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Orientation" htmlFor="set-orient">
          <select
            id="set-orient"
            className="input"
            value={settings.defaultPageOrientation}
            onChange={(e) => void update({ defaultPageOrientation: e.target.value })}
          >
            <option value="portrait">Portrait</option>
            <option value="landscape">Landscape</option>
          </select>
        </Field>
      </section>

      <section className="settings-group">
        <h2 className="section-title">Pen &amp; stylus defaults</h2>
        <Field label="Pen colour" htmlFor="set-pen-colour">
          <input
            id="set-pen-colour"
            type="color"
            value={settings.defaultPenColor}
            onChange={(e) => void update({ defaultPenColor: e.target.value })}
          />
        </Field>
        <Field label="Pen width" htmlFor="set-pen-width">
          <input
            id="set-pen-width"
            type="range"
            min={0.5}
            max={15.4}
            step={0.1}
            value={settings.defaultPenWidth}
            onChange={(e) => void update({ defaultPenWidth: Number(e.target.value) })}
          />
          <span className="muted">{settings.defaultPenWidth.toFixed(1)}</span>
        </Field>
        <Field label="Highlighter colour" htmlFor="set-hl-colour">
          <input
            id="set-hl-colour"
            type="color"
            value={settings.defaultHighlighterColor}
            onChange={(e) => void update({ defaultHighlighterColor: e.target.value })}
          />
        </Field>
        <Field label="Highlighter width" htmlFor="set-hl-width">
          <input
            id="set-hl-width"
            type="range"
            min={5}
            max={40}
            step={0.1}
            value={settings.defaultHighlighterWidth}
            onChange={(e) => void update({ defaultHighlighterWidth: Number(e.target.value) })}
          />
          <span className="muted">{settings.defaultHighlighterWidth.toFixed(1)}</span>
        </Field>
      </section>

      <section className="settings-group">
        <h2 className="section-title">Writing</h2>
        <Field label="Ink to shape" htmlFor="set-ink-shape">
          <input
            id="set-ink-shape"
            type="checkbox"
            checked={settings.inkToShape}
            onChange={(e) => void update({ inkToShape: e.target.checked })}
          />
          <span className="muted">Hold the pen still at the end of a stroke to turn it into a shape</span>
        </Field>
        <Field label="Snap when lifting the pen" htmlFor="set-ink-shape-release">
          <input
            id="set-ink-shape-release"
            type="checkbox"
            checked={settings.inkToShapeSnapsOnRelease}
            onChange={(e) => void update({ inkToShapeSnapsOnRelease: e.target.checked })}
          />
        </Field>
        <Field label="Hold time" htmlFor="set-ink-shape-dwell">
          <input
            id="set-ink-shape-dwell"
            type="range"
            min={300}
            max={2000}
            step={50}
            value={settings.inkToShapeDwellMs}
            onChange={(e) => void update({ inkToShapeDwellMs: Number(e.target.value) })}
          />
          <span className="muted">{settings.inkToShapeDwellMs} ms</span>
        </Field>
        <Field label="Scribble to erase" htmlFor="set-scribble">
          <input
            id="set-scribble"
            type="checkbox"
            checked={settings.scribbleToErase}
            onChange={(e) => void update({ scribbleToErase: e.target.checked })}
          />
          <span className="muted">Scribble quickly over pen ink to erase it</span>
        </Field>
        <Field label="Scribble sensitivity" htmlFor="set-scribble-sensitivity">
          <select
            id="set-scribble-sensitivity"
            className="input"
            value={settings.scribbleEraseSensitivity}
            onChange={(e) => void update({ scribbleEraseSensitivity: e.target.value })}
          >
            <option value="less">Less</option>
            <option value="standard">Standard</option>
            <option value="more">More</option>
          </select>
        </Field>
        <h3 className="field-subtitle">Text defaults</h3>
        <Field label="Text colour" htmlFor="set-text-colour">
          <input id="set-text-colour" type="color" value={settings.defaultTextColor} onChange={(e) => void update({ defaultTextColor: e.target.value })} />
        </Field>
        <Field label="Text size" htmlFor="set-text-size">
          <input id="set-text-size" type="range" min={8} max={72} step={0.5} value={settings.defaultTextSize} onChange={(e) => void update({ defaultTextSize: Number(e.target.value) })} />
          <span className="muted">{settings.defaultTextSize.toFixed(1)}</span>
        </Field>
        <h3 className="field-subtitle">Shape defaults</h3>
        <Field label="Shape type" htmlFor="set-shape-type">
          <select id="set-shape-type" className="input" value={settings.defaultShapeType} onChange={(e) => void update({ defaultShapeType: e.target.value as ShapeType })}>
            {SHAPE_TYPES.map((t) => (
              <option key={t} value={t}>{SHAPE_LABEL[t]}</option>
            ))}
          </select>
        </Field>
        <Field label="Shape stroke colour" htmlFor="set-shape-stroke">
          <input id="set-shape-stroke" type="color" value={settings.defaultShapeStrokeColor} onChange={(e) => void update({ defaultShapeStrokeColor: e.target.value })} />
        </Field>
        <Field label="Shape fill colour" htmlFor="set-shape-fill">
          <input id="set-shape-fill" type="color" value={hexOr(settings.defaultShapeFillColor, "#ffffff")} onChange={(e) => void update({ defaultShapeFillColor: e.target.value })} />
        </Field>
        <Field label="Shape width" htmlFor="set-shape-width">
          <input id="set-shape-width" type="range" min={0.5} max={20} step={0.5} value={settings.defaultShapeStrokeWidth} onChange={(e) => void update({ defaultShapeStrokeWidth: Number(e.target.value) })} />
          <span className="muted">{settings.defaultShapeStrokeWidth.toFixed(1)}</span>
        </Field>
        <Field label="Shape fill opacity" htmlFor="set-shape-opacity">
          <input id="set-shape-opacity" type="range" min={0} max={1} step={0.05} value={settings.defaultShapeFillOpacity} onChange={(e) => void update({ defaultShapeFillOpacity: Number(e.target.value) })} />
          <span className="muted">{Math.round(settings.defaultShapeFillOpacity * 100)}%</span>
        </Field>
        <h3 className="field-subtitle">Eraser defaults</h3>
        <Field label="Eraser type" htmlFor="set-eraser-type">
          <select id="set-eraser-type" className="input" value={settings.defaultEraserType} onChange={(e) => void update({ defaultEraserType: e.target.value })}>
            <option value="stroke">Whole stroke</option>
            <option value="partial">Partial</option>
          </select>
        </Field>
        <Field label="Eraser width" htmlFor="set-eraser-width">
          <input id="set-eraser-width" type="range" min={4} max={100} step={1} value={settings.defaultEraserWidth} onChange={(e) => void update({ defaultEraserWidth: Number(e.target.value) })} />
          <span className="muted">{settings.defaultEraserWidth}</span>
        </Field>
        <Field label="Erase shapes" htmlFor="set-erase-shapes">
          <input id="set-erase-shapes" type="checkbox" checked={settings.eraserEraseShapes} onChange={(e) => void update({ eraserEraseShapes: e.target.checked })} />
        </Field>
        <Field label="Erase images" htmlFor="set-erase-images">
          <input id="set-erase-images" type="checkbox" checked={settings.eraserEraseImages} onChange={(e) => void update({ eraserEraseImages: e.target.checked })} />
        </Field>
      </section>

      <section className="settings-group">
        <h2 className="section-title">Intelligence</h2>
        <AiSettings />
      </section>

      <section className="settings-group">
        <h2 className="section-title">Appearance</h2>
        <Field label="Invert images in dark mode" htmlFor="set-invert-images">
          <input
            id="set-invert-images"
            type="checkbox"
            checked={settings.invertImagesInDarkMode}
            onChange={(e) => void update({ invertImagesInDarkMode: e.target.checked })}
          />
          <span className="muted">Black-and-white images are inverted on dark themes</span>
        </Field>
      </section>

      <section className="settings-group">
        <h2 className="section-title">Trash</h2>
        <Field label="Keep deleted items for" htmlFor="set-retention">
          <select
            id="set-retention"
            className="input"
            value={settings.trashRetentionDays}
            onChange={(e) => void update({ trashRetentionDays: Number(e.target.value) })}
          >
            {RETENTION.map((d) => (
              <option key={d} value={d}>{d === 0 ? "Forever" : `${d} days`}</option>
            ))}
          </select>
        </Field>
      </section>
    </div>
  );
}
