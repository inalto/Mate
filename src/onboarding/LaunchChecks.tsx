import { useCallback, useEffect, useRef, useState } from "react";
import WhatsNew from "../components/WhatsNew";
import { getAppVersion } from "../ipc/app";
import { navigateTo } from "../stores/navigation";
import { useSettingsStore } from "../stores/settings";
import { whatsNewFor } from "../whatsnew";
import { shouldShowWelcome, whatsNewAction } from "./launch";

/** Once settings are loaded: first run goes to /welcome; later launches may show What's new. */
export default function LaunchChecks() {
  const loaded = useSettingsStore((s) => s.loaded);
  const [notes, setNotes] = useState<{ version: string; text: string } | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (!loaded || ran.current) return;
    ran.current = true;
    const { settings, update } = useSettingsStore.getState();
    const firstRun = shouldShowWelcome(settings);
    if (firstRun) navigateTo("/welcome");
    void getAppVersion().then(
      (version) => {
        const action = whatsNewAction(settings, !firstRun, version);
        const text = whatsNewFor(version);
        if (action === "show" && text) setNotes({ version, text });
        else if (action !== "none") void update({ lastSeenVersion: version });
      },
      () => {},
    );
  }, [loaded]);

  const close = useCallback(() => {
    if (notes) void useSettingsStore.getState().update({ lastSeenVersion: notes.version });
    setNotes(null);
  }, [notes]);

  return notes ? <WhatsNew notes={notes.text} onClose={close} /> : null;
}
