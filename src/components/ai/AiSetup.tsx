import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getAiStatus, listAiProviders } from "../../ipc/ai";
import type { AiProviderInfo, AiStatus } from "../../model/types";
import { flushSettings, useSettingsStore } from "../../stores/settings";
import { ADDRESS_REFRESH_MS } from "../../tutor/aiStatus";
import "./ai.css";
import ConnectionFields from "./ConnectionFields";
import NeedsExplainer from "./NeedsExplainer";
import ProviderPicker from "./ProviderPicker";

/** Choose an AI provider and connect it: what Mate needs, the catalog, then the connection fields. */
export default function AiSetup() {
  const { t } = useTranslation();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const [providers, setProviders] = useState<AiProviderInfo[]>([]);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
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
      () => mounted.current && setLoadFailed(true),
    );
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  // A typed address changes what the status says (configured, local); read it once typing pauses
  // and the setting is on disk.
  const address = settings.aiBaseUrl;
  const firstAddress = useRef(address);
  useEffect(() => {
    if (address === firstAddress.current) return;
    firstAddress.current = address;
    const timer = setTimeout(() => {
      void flushSettings()
        .catch(() => {})
        .then(refresh);
    }, ADDRESS_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [address, refresh]);

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
      {loadFailed && <p className="form-error">{t("ai.loadFailed")}</p>}
      <ProviderPicker providers={providers} value={settings.aiProvider} onSelect={(id) => void select(id)} />
      {textOnly && <p className="muted" role="note">{t("ai.noVision")}</p>}
      {info && <ConnectionFields key={info.id} info={info} status={status} onChanged={refresh} />}
    </div>
  );
}
