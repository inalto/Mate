import { getVersion } from "@tauri-apps/api/app";

/** The installed app version (from tauri.conf.json). */
export const getAppVersion = (): Promise<string> => getVersion();
