import { invoke } from "@tauri-apps/api/core";
import { sessionAttempts, type BlockKind } from "../tutor/attempts";
import { isRecognizeError, recognizeErrorText } from "./recognize";

const BLOCKING: ReadonlySet<string> = new Set(["auth", "billing", "unknownModel"]);

/**
 * Calls an AI-backed command (summary, title, practice). A rejected key, a billing problem or an
 * unknown model blocks live tutor checking like a failed check does (lifted by a new key,
 * provider or model); the call rejects with a plain `Error` carrying the readable sentence.
 */
export async function invokeAi<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    if (isRecognizeError(e)) {
      const text = recognizeErrorText(e);
      if (BLOCKING.has(e.kind) && !sessionAttempts.block) sessionAttempts.setBlock(e.kind as BlockKind, text);
      throw new Error(text);
    }
    throw e;
  }
}
