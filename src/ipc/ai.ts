import { invoke } from "@tauri-apps/api/core";
import type { AiProvider, AiProviderInfo, AiStatus } from "../model/types";
import { notifyKeyChanged, sessionAttempts } from "../tutor/attempts";

/** Stores the key in the OS keychain (Rust side); it is never read back. A new key lifts a
 * "key not accepted" block on live checking. */
export const setAiKey = async (provider: AiProvider, key: string): Promise<void> => {
  await invoke("set_ai_key", { provider, key });
  sessionAttempts.clearAuthBlock();
  notifyKeyChanged();
};

export const clearAiKey = async (provider: AiProvider): Promise<void> => {
  await invoke("clear_ai_key", { provider });
  sessionAttempts.clearAuthBlock();
  notifyKeyChanged();
};

export const getAiStatus = (): Promise<AiStatus> => invoke("get_ai_status");

export const testAiKey = (provider: AiProvider): Promise<void> => invoke("test_ai_key", { provider });

/** The provider catalog (labels, groups, what each needs). */
export const listAiProviders = (): Promise<AiProviderInfo[]> => invoke("list_ai_providers");

/** Model names the current provider offers, using the saved settings and key. Rejects with a readable message. */
export const listAiModels = (): Promise<string[]> => invoke("list_ai_models");
