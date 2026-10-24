import { invoke } from "@tauri-apps/api/core";

/** What the UI may know about Wolfram|Alpha. The AppID itself never comes back. */
export interface WolframStatus {
  configured: boolean;
  consent: boolean;
}

/** Stores the AppID in the OS keychain (Rust side); it is never read back. */
export const setWolframAppid = (appid: string): Promise<void> => invoke("set_wolfram_appid", { appid });

export const clearWolframAppid = (): Promise<void> => invoke("clear_wolfram_appid");

export const wolframStatus = (): Promise<WolframStatus> => invoke("wolfram_status");

/** Asks Wolfram|Alpha a trivial question; rejects with a readable message. */
export const testWolframAppid = (): Promise<void> => invoke("test_wolfram_appid");

/** The short answer to `query` (plain text). Rejects with a readable message, e.g. when it is off. */
export const wolframShortAnswer = (query: string): Promise<string> => invoke("wolfram_short_answer", { query });
