import { FloppyDisk, PlugsConnected, Trash } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage as message } from "../../../i18n";
import { openExternal } from "../../../ipc/app";
import { clearWolframAppid, setWolframAppid, testWolframAppid, wolframStatus } from "../../../ipc/math";
import { AiIcon } from "../../../components/ai/AiField";
import "../../../components/ai/ai.css";
import { Row, SettingsSection, ToggleRow } from "../rows";

const DEVELOPER_URL = "https://developer.wolframalpha.com/";

export default function MathEnginesSection() {
  const { t } = useTranslation();
  const [configured, setConfigured] = useState(false);
  const [draft, setDraft] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const s = await wolframStatus();
      if (mounted.current) setConfigured(s.configured);
    } catch {
      /* the status just stays as it was */
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  const run = async (action: () => Promise<void>, success: string | null) => {
    setBusy(true);
    setResult(null);
    try {
      await action();
      if (mounted.current && success) setResult(success);
    } catch (err) {
      if (mounted.current) setResult(message(err));
    } finally {
      if (mounted.current) setBusy(false);
      await refresh();
    }
  };

  return (
    <SettingsSection id="math-engines" title={t("settings.nav.sections.mathEngines")}>
      <p className="muted">{t("settings.mathEngines.explainer")}</p>
      <Row id="set-wolfram-appid" label={t("settings.mathEngines.appid")} htmlFor="set-wolfram-appid-input">
        <div className="ai-field-body">
          <div className="ai-row">
            <input
              id="set-wolfram-appid-input"
              className="input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draft}
              placeholder={configured ? t("settings.mathEngines.savedHidden") : t("settings.mathEngines.pasteAppid")}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || draft.trim() === ""}
              onClick={() => {
                const id = draft;
                setDraft("");
                void run(() => setWolframAppid(id), null);
              }}
            >
              <AiIcon icon={FloppyDisk} />
              {t("common.save")}
            </button>
            <button type="button" className="btn" disabled={busy || !configured} onClick={() => void run(() => clearWolframAppid(), null)}>
              <AiIcon icon={Trash} />
              {t("common.remove")}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || !configured}
              onClick={() => void run(() => testWolframAppid(), t("settings.mathEngines.works"))}
            >
              <AiIcon icon={PlugsConnected} />
              {t("common.test")}
            </button>
          </div>
          <span className="muted" role="status">
            {result ?? (configured ? t("settings.mathEngines.saved") : t("settings.mathEngines.none"))}
          </span>
        </div>
      </Row>
      <ToggleRow
        k="wolframConsent"
        label={t("settings.mathEngines.consent.label")}
        hint={t("settings.mathEngines.consent.hint")}
      />
      <Row id="set-wolfram-link" label={t("settings.mathEngines.getAppid")}>
        <a
          href={DEVELOPER_URL}
          onClick={(e) => {
            e.preventDefault();
            void openExternal(DEVELOPER_URL).catch(() => {});
          }}
        >
          developer.wolframalpha.com
        </a>
      </Row>
    </SettingsSection>
  );
}
