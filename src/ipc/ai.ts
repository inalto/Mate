import { invoke } from "@tauri-apps/api/core";
import type { AiProvider, AiStatus } from "../model/types";
import { sessionAttempts } from "../tutor/attempts";

/** Stores the key in the OS keychain (Rust side); it is never read back. A new key lifts a
 * "key not accepted" block on live checking. */
export const setAiKey = async (provider: AiProvider, key: string): Promise<void> => {
  await invoke("set_ai_key", { provider, key });
  sessionAttempts.clearAuthBlock();
};

export const clearAiKey = async (provider: AiProvider): Promise<void> => {
  await invoke("clear_ai_key", { provider });
  sessionAttempts.clearAuthBlock();
};

export const getAiStatus = (): Promise<AiStatus> => invoke("get_ai_status");

export const testAiKey = (provider: AiProvider): Promise<void> => invoke("test_ai_key", { provider });
