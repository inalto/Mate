import {
  ArrowSquareOut,
  Cloud,
  Coins,
  Desktop,
  Eye,
  EyeSlash,
  Key,
  Plug,
  Question,
  type Icon,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import type { TKey } from "../../i18n";
import { openExternal } from "../../ipc/app";
import type { AiProviderGroup, AiProviderInfo, AiVision } from "../../model/types";
import { AiIcon } from "./AiField";

const GROUPS: Array<{ id: AiProviderGroup; titleKey: TKey; icon: Icon }> = [
  { id: "cloud", titleKey: "ai.groups.cloud", icon: Cloud },
  { id: "local", titleKey: "ai.groups.local", icon: Desktop },
  { id: "custom", titleKey: "ai.groups.custom", icon: Plug },
];

const VISION_COPY: Record<AiVision, { key: TKey; icon: Icon }> = {
  yes: { key: "ai.vision.yes", icon: Eye },
  dependsOnModel: { key: "ai.vision.dependsOnModel", icon: Question },
  no: { key: "ai.vision.no", icon: EyeSlash },
};

const needsCopy = (p: AiProviderInfo): TKey =>
  p.group === "local" ? "ai.needsLocal" : p.group === "custom" ? "ai.needsCustom" : "ai.needsCloud";

interface Props {
  providers: AiProviderInfo[];
  value: string;
  onSelect(id: string): void;
}

/** The catalog as radio cards in three groups. Cards carry search attributes for Settings search. */
export default function ProviderPicker({ providers, value, onSelect }: Props) {
  const { t } = useTranslation();
  return (
    <div className="ai-picker">
      {GROUPS.map((g) => {
        const items = providers.filter((p) => p.group === g.id);
        if (items.length === 0) return null;
        return (
          <fieldset key={g.id} className="ai-group">
            <legend>
              <AiIcon icon={g.icon} />
              {t(g.titleKey)}
            </legend>
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
                  <p className="muted ai-info">
                    <AiIcon icon={Key} />
                    {t(needsCopy(p))}
                  </p>
                  <p className="muted ai-info">
                    <AiIcon icon={VISION_COPY[p.vision].icon} />
                    {t(VISION_COPY[p.vision].key)}
                  </p>
                  <p className="muted ai-info">
                    <AiIcon icon={Coins} />
                    {t("ai.costLine", { cost: t(`ai.cost.${p.cost}`) })}
                  </p>
                  {p.keyUrl && (
                    <button
                      type="button"
                      className="btn ai-link"
                      onClick={() => void openExternal(p.keyUrl).catch(() => {})}
                    >
                      <AiIcon icon={ArrowSquareOut} />
                      {t("ai.getKey")}
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
