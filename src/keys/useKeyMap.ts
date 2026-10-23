import { useMemo } from "react";
import { useSettingsStore } from "../stores/settings";
import { effectiveMap, type KeyMap, type KeyOverride } from "./keybindings";

/** The effective action -> keys map, following `settings.keybindings`. */
export function useKeyMap(): KeyMap {
  const overrides = useSettingsStore((s) => s.settings.keybindings);
  return useMemo(() => effectiveMap(overrides ?? []), [overrides]);
}

/** Persist the overrides through the settings store. */
export function saveOverrides(overrides: KeyOverride[]): Promise<void> {
  return useSettingsStore.getState().update({ keybindings: overrides });
}
