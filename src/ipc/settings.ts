import { invoke } from "@tauri-apps/api/core";
import type { Settings } from "../model/types";

export const getSettings = (): Promise<Settings> => invoke("get_settings");

export const setSettings = (settings: Settings): Promise<void> =>
  invoke("set_settings", { settings });
