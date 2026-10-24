import { useCallback, useEffect, useRef, useState } from "react";
import { getAiStatus, listAiProviders } from "../../ipc/ai";
import type { AiProviderInfo, AiStatus } from "../../model/types";
import { useSettingsStore } from "../../stores/settings";
import "./ai.css";
import ConnectionFields from "./ConnectionFields";
import NeedsExplainer from "./NeedsExplainer";
import ProviderPicker from "./ProviderPicker";

export const NO_VISION_NOTE =
  "This provider cannot read handwriting, so checking is off. Ask, summaries and practice still work.";

/** Choose an AI provider and connect it: what Mate needs, the catalog, then the connection fields. */
export default function AiSetup() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const [providers, setProviders] = useState<AiProviderInfo[]>([]);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await getAiStatus();
      if (mounted.current) setStatus(next);
    } catch {
      /* the status line just stays as it was */
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    listAiProviders().then(
      (list) => mounted.current && setProviders(list),
      () => mounted.current && setError("Could not load the list of AI services."),
    );
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  const select = async (id: string) => {
    // The status reads the persisted settings, so wait for the write before asking.
    await update({ aiProvider: id, aiModel: "", aiBaseUrl: "" }).catch(() => {});
    await refresh();
  };

  const info = providers.find((p) => p.id === settings.aiProvider);
  const current = status?.provider === settings.aiProvider ? status : null;
  const textOnly = (current?.vision ?? info?.vision) === "no";

  return (
    <div className="ai-setup">
      <NeedsExplainer open={!current?.configured} />
      {error && <p className="form-error">{error}</p>}
      <ProviderPicker providers={providers} value={settings.aiProvider} onSelect={(id) => void select(id)} />
      {info && <ConnectionFields key={info.id} info={info} status={status} onChanged={refresh} />}
      {textOnly && <p className="muted" role="note">{NO_VISION_NOTE}</p>}
    </div>
  );
}
