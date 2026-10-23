import { invoke } from "@tauri-apps/api/core";
import type { AiProvider, AiStatus } from "../model/types";

/** Stores the key in the OS keychain (Rust side); it is never read back. */
export const setAiKey = (provider: AiProvider, key: string): Promise<void> =>
  invoke("set_ai_key", { provider, key });

export const clearAiKey = (provider: AiProvider): Promise<void> => invoke("clear_ai_key", { provider });

export const getAiStatus = (): Promise<AiStatus> => invoke("get_ai_status");

export const testAiKey = (provider: AiProvider): Promise<void> => invoke("test_ai_key", { provider });
