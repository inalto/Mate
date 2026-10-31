import { invoke } from "@tauri-apps/api/core";

let mobile = false;
let os = "";

function apply(value: boolean, osName = ""): void {
  mobile = value;
  os = osName;
  document.documentElement.classList.toggle("mobile", value);
}

/** Ask the shell which platform we run on; outside Tauri, assume desktop. */
export async function loadPlatform(): Promise<void> {
  try {
    const info = await invoke<{ mobile: boolean; os: string }>("platform_info");
    apply(info.mobile === true, typeof info.os === "string" ? info.os : "");
  } catch {
    apply(false);
  }
}

export function isMobile(): boolean {
  return mobile;
}

/** The shell's os name ("ios", "android", ...); "" before load or outside Tauri. */
export function platformOs(): string {
  return os;
}

export function setPlatformForTests(value: boolean, osName = ""): void {
  apply(value, osName);
}
