// The "Ask Wolfram|Alpha" entry of the Compute menu: its enabled state follows the stored AppID
// (Rust-side status) and the consent setting; running it sends the typed maths (as plain text)
// and inserts the short answer as a text box under the source.
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ComputeMenuItem } from "../components/ComputeMenu";
import { showToast } from "../components/Toast";
import { wolframShortAnswer, wolframStatus } from "../ipc/math";
import { useSettingsStore } from "../stores/settings";
import { latexToPlain } from "./cas";
import { insertResultBelow } from "./computeResult";
import { latexOf } from "./mathBox";

export function useWolframItem(): ComputeMenuItem[] {
  const consent = useSettingsStore((s) => s.settings.wolframConsent);
  const { t } = useTranslation();
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
    const title = !configured ? t("math.wolfram.needsAppid") : !consent ? t("math.wolfram.needsConsent") : undefined;
    return [
      {
        key: "wolfram",
        label: t("math.wolfram.ask"),
        disabled: title !== undefined,
        title,
        async run({ store, source }) {
          const query = await latexToPlain(latexOf(source));
          const answer = await wolframShortAnswer(query);
          if (!insertResultBelow(store, source, { text: answer })) showToast(t("math.resultNotAdded"));
        },
      },
    ];
  }, [configured, consent, t]);
}
