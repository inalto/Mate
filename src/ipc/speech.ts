// Dictation commands. Keys go into the keychain through Rust and never come back; the recording is
// sent as the raw request body and Rust reads the settings and key itself.
import { invoke } from "@tauri-apps/api/core";

/** One speech-to-text service of the Rust catalog (`mate_core::ai::speech`). */
export interface SpeechProviderInfo {
  id: string;
  label: string;
  needsKey: boolean;
  editableBaseUrl: boolean;
  defaultBaseUrl: string;
  defaultModel: string;
  keyUrl: string;
  local: boolean;
}

/** What the UI may know about the dictation setup (never the key). */
export interface SpeechStatus {
  configured: boolean;
  hasKey: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  consent: boolean;
  needsKey: boolean;
  local: boolean;
}

export const listSpeechProviders = (): Promise<SpeechProviderInfo[]> => invoke("list_speech_providers");

export const getSpeechStatus = (): Promise<SpeechStatus> => invoke("get_speech_status");

export const setSpeechKey = (provider: string, key: string): Promise<void> => invoke("set_speech_key", { provider, key });

export const clearSpeechKey = (provider: string): Promise<void> => invoke("clear_speech_key", { provider });

/**
 * Turns a recording into text with the configured service. Rejects with a structured error
 * (`{ kind, message }`, worded by `recognizeErrorText`) when consent, key or address are missing
 * or the service fails.
 */
export const transcribeAudio = (bytes: Uint8Array, mime: string, language?: string): Promise<string> =>
  invoke<string>("transcribe_audio", bytes, {
    headers: { "x-speech-mime": mime, ...(language ? { "x-speech-language": language } : {}) },
  });

/**
 * Sends half a second of silence to the configured service (with the same consent, key and
 * address checks as a dictation) and resolves when it answered; rejects like `transcribeAudio`.
 */
export const testSpeechKey = (): Promise<void> => invoke("test_speech_key");

/** The dictated text after the AI assistant's tidy-up. */
export interface TidyResult {
  /** Punctuated and capitalised text; for maths, the expression as notation (`y = x + 10`). */
  text: string;
  kind: "text" | "math";
  /** LaTeX of the expression when `kind` is `"math"`, else null. */
  latex: string | null;
}

/**
 * Asks the AI assistant to fix punctuation and casing of a dictated passage and to write spoken
 * maths as notation. Only the transcribed text (never audio) is sent to the AI assistant, and only
 * with its consent. Rejects with `{ kind, message }` like `transcribeAudio`.
 */
export const tidyDictation = (text: string, language?: string): Promise<TidyResult> =>
  invoke<TidyResult>("tidy_dictation", { text, language: language ?? null });
