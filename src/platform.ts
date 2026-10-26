import { invoke } from "@tauri-apps/api/core";

let mobile = false;

function apply(value: boolean): void {
  mobile = value;
  document.documentElement.classList.toggle("mobile", value);
}

/** Ask the shell which platform we run on; outside Tauri, assume desktop. */
export async function loadPlatform(): Promise<void> {
  try {
    const info = await invoke<{ mobile: boolean; os: string }>("platform_info");
    apply(info.mobile === true);
  } catch {
    apply(false);
  }
}

export function isMobile(): boolean {
  return mobile;
}

export function setPlatformForTests(value: boolean): void {
  apply(value);
}
