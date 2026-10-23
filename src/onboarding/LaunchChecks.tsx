import { useCallback, useEffect, useRef, useState } from "react";
import WhatsNew from "../components/WhatsNew";
import { getAppVersion } from "../ipc/app";
import { navigateTo } from "../stores/navigation";
import { useImportStore } from "../stores/importStore";
import { useNotebookStore } from "../stores/notebook";
import { useSettingsStore } from "../stores/settings";
import { whatsNewFor } from "../whatsnew";
import { hasFileLaunch, markFileLaunch, onFileLaunch } from "./fileLaunch";
import { shouldShowWelcome, whatsNewAction } from "./launch";

/**
 * Once settings and the notebook are loaded: a first run goes to /welcome, unless the library
 * already has pages (an upgrade from a version without onboarding) or the app was launched with a
 * file; later launches may show What's new.
 */
export default function LaunchChecks() {
  const loaded = useSettingsStore((s) => s.loaded);
  const notebookLoaded = useNotebookStore((s) => s.loaded);
  const [notes, setNotes] = useState<{ version: string; text: string } | null>(null);
  const ran = useRef(false);

  // A notebook file opened through the import dialog counts as a file launch.
  useEffect(() => {
    let was = useImportStore.getState().open;
    return useImportStore.subscribe((s) => {
      if (s.open && !was) markFileLaunch();
      was = s.open;
    });
  }, []);

  // A file arriving after the check: do not show the welcome flow later.
  useEffect(
    () =>
      onFileLaunch(() => {
        if (!ran.current) return;
        const { settings, update } = useSettingsStore.getState();
        if (!settings.onboardingDone) void update({ onboardingDone: true });
        if (window.location.pathname === "/welcome" && useImportStore.getState().open) navigateTo("/");
      }),
    [],
  );

  useEffect(() => {
    if (!loaded || !notebookLoaded || ran.current) return;
    ran.current = true;
    const { settings, update } = useSettingsStore.getState();
    const hasLibrary = useNotebookStore.getState().tree.pages.some((p) => !p.deletedAt);
    let firstRun = shouldShowWelcome(settings);
    if (firstRun && (hasLibrary || hasFileLaunch())) {
      firstRun = false;
      void update({ onboardingDone: true });
    }
    // On a first run no notes are shown; the version is only remembered.
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
  }, [loaded, notebookLoaded]);

  const close = useCallback(() => {
    if (notes) void useSettingsStore.getState().update({ lastSeenVersion: notes.version });
    setNotes(null);
  }, [notes]);

  return notes ? <WhatsNew notes={notes.text} onClose={close} /> : null;
}
