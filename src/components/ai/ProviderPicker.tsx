import { openExternal } from "../../ipc/app";
import type { AiProviderGroup, AiProviderInfo, AiVision } from "../../model/types";

const GROUPS: Array<{ id: AiProviderGroup; title: string }> = [
  { id: "cloud", title: "Cloud services" },
  { id: "local", title: "On this computer" },
  { id: "custom", title: "Custom" },
];

const VISION_COPY: Record<AiVision, string> = {
  yes: "Handwriting: can read it",
  dependsOnModel: "Handwriting: depends on the model",
  no: "Handwriting: text only, so checking is off",
};

const needsCopy = (p: AiProviderInfo): string =>
  p.group === "local"
    ? "Needs: the program running on this computer, no key"
    : p.group === "custom"
      ? "Needs: a web address, and a key if the service wants one"
      : "Needs: an API key from the service";

interface Props {
  providers: AiProviderInfo[];
  value: string;
  onSelect(id: string): void;
}

/** The catalog as radio cards in three groups. Cards carry search attributes for Settings search. */
export default function ProviderPicker({ providers, value, onSelect }: Props) {
  return (
    <div className="ai-picker">
      {GROUPS.map((g) => {
        const items = providers.filter((p) => p.group === g.id);
        if (items.length === 0) return null;
        return (
          <fieldset key={g.id} className="ai-group">
            <legend>{g.title}</legend>
            <div className="ai-cards">
              {items.map((p) => (
                <div
                  key={p.id}
                  className={`card ai-card${p.id === value ? " ai-card-on" : ""}`}
                  data-row-id={`ai-provider-${p.id}`}
                  data-row-label={p.label}
                >
                  <label className="ai-card-head">
                    <input
                      type="radio"
                      name="ai-provider"
                      value={p.id}
                      checked={p.id === value}
                      onChange={() => onSelect(p.id)}
                    />{" "}
                    <strong>{p.label}</strong>
                  </label>
                  <p className="muted">{needsCopy(p)}</p>
                  <p className="muted">{VISION_COPY[p.vision]}</p>
                  <p className="muted">Cost: {p.cost}</p>
                  {p.keyUrl && (
                    <button
                      type="button"
                      className="btn ai-link"
                      onClick={() => void openExternal(p.keyUrl).catch(() => {})}
                    >
                      Get a key
                    </button>
                  )}
                </div>
              ))}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}
