import { invoke } from "@tauri-apps/api/core";

export type SyncService = "dropbox" | "googledrive" | "onedrive" | "icloud" | "nextcloud";

export interface SyncFolder {
  service: SyncService;
  label: string;
  path: string;
}

export interface NextcloudStatus {
  signedIn: boolean;
  server: string;
  user: string;
}

export interface NextcloudShare {
  url: string;
  path: string;
}

/** Cloud-sync folders found on this computer. */
export const detectSyncFolders = (): Promise<SyncFolder[]> => invoke("detect_sync_folders");

/** Write the book as a `.mate` file under `<dir>/Mate/`, without recordings unless asked. Resolves to the written path. */
export const saveArchiveTo = (unitId: string, dir: string, includeRecordings = false): Promise<string> =>
  invoke("save_archive_to", { unitId, dir, includeRecordings });

/** Folder picker. `null` if cancelled. */
export const pickFolder = (): Promise<string | null> => invoke("pick_folder");

export const nextcloudStatus = (): Promise<NextcloudStatus> => invoke("nextcloud_status");

/** Opens the browser to approve this device; follow with `nextcloudLoginPoll` every 2 s. */
export const nextcloudLoginStart = (server: string): Promise<void> => invoke("nextcloud_login_start", { server });

export const nextcloudLoginPoll = (): Promise<{ done: boolean }> => invoke("nextcloud_login_poll");

export const nextcloudLogout = (): Promise<void> => invoke("nextcloud_logout");

/**
 * Upload the book and create a public link. `expireDays` null means the link never expires.
 * Recordings are left out unless `includeRecordings` is true.
 */
export const nextcloudShare = (unitId: string, expireDays: number | null, includeRecordings = false): Promise<NextcloudShare> =>
  invoke("nextcloud_share", { unitId, expireDays, includeRecordings });
