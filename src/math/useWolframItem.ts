// The "Ask Wolfram|Alpha" entry of the Compute menu: its enabled state follows the stored AppID
// (Rust-side status) and the consent setting; running it sends the typed maths (as plain text)
// and inserts the short answer as a text box under the source.
import { useEffect, useMemo, useState } from "react";
import type { ComputeMenuItem } from "../components/ComputeMenu";
import { showToast } from "../components/Toast";
import { wolframShortAnswer, wolframStatus } from "../ipc/math";
import { useSettingsStore } from "../stores/settings";
import { latexToPlain } from "./cas";
import { insertResultBelow } from "./computeResult";
import { latexOf } from "./mathBox";

export const WOLFRAM_LABEL = "Ask Wolfram|Alpha";
export const NEEDS_APPID = "Add a Wolfram|Alpha AppID in Settings first.";
export const NEEDS_CONSENT = "Wolfram|Alpha is off. Turn it on in Settings.";

export function useWolframItem(): ComputeMenuItem[] {
  const consent = useSettingsStore((s) => s.settings.wolframConsent);
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    let live = true;
    wolframStatus().then(
      (s) => live && setConfigured(s.configured),
      () => live && setConfigured(false),
    );
    return () => {
      live = false;
    };
  }, []);

  return useMemo(() => {
    const title = !configured ? NEEDS_APPID : !consent ? NEEDS_CONSENT : undefined;
    return [
      {
        key: "wolfram",
        label: WOLFRAM_LABEL,
        disabled: title !== undefined,
        title,
        async run({ store, source }) {
          const query = await latexToPlain(latexOf(source));
          const answer = await wolframShortAnswer(query);
          if (!insertResultBelow(store, source, { text: answer })) showToast("The result could not be added to this page.");
        },
      },
    ];
  }, [configured, consent]);
}
