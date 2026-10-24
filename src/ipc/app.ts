import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";

/** The installed app version (from tauri.conf.json). */
export const getAppVersion = (): Promise<string> => getVersion();

/** Opens a web link in the default browser. */
export const openExternal = (url: string): Promise<void> => openUrl(url);
