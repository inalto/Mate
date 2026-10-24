import { useCallback, useEffect, useRef, useState } from "react";
import { openExternal } from "../../../ipc/app";
import { clearWolframAppid, setWolframAppid, testWolframAppid, wolframStatus } from "../../../ipc/math";
import { Row, SettingsSection, ToggleRow } from "../rows";

const message = (err: unknown): string =>
  typeof err === "string" ? err : err instanceof Error ? err.message : "Something went wrong.";

export const EXPLAINER =
  "Compute Engine runs on this computer and needs nothing. Wolfram|Alpha needs a free AppID (2 000 queries a month for non-commercial use).";
const DEVELOPER_URL = "https://developer.wolframalpha.com/";

export default function MathEnginesSection() {
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
    <SettingsSection id="math-engines" title="Maths engines">
      <p className="muted">{EXPLAINER}</p>
      <Row id="set-wolfram-appid" label="Wolfram|Alpha AppID" htmlFor="set-wolfram-appid-input">
        <input
          id="set-wolfram-appid-input"
          className="input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          placeholder={configured ? "Saved (hidden)" : "Paste your AppID"}
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
          Save
        </button>
        <button type="button" className="btn" disabled={busy || !configured} onClick={() => void run(() => clearWolframAppid(), null)}>
          Remove
        </button>
        <button type="button" className="btn" disabled={busy || !configured} onClick={() => void run(() => testWolframAppid(), "The AppID works.")}>
          Test
        </button>
        <span className="muted" role="status">
          {result ?? (configured ? "AppID saved" : "No AppID")}
        </span>
      </Row>
      <ToggleRow k="wolframConsent" label="Send typed maths to Wolfram|Alpha when I ask" hint="Nothing is sent until you turn this on and choose Ask Wolfram|Alpha." />
      <Row id="set-wolfram-link" label="Get a free AppID">
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
