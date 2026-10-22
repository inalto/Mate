import { invoke } from "@tauri-apps/api/core";

/** True if `attemptId` is still the current close attempt (false when superseded or timed out). */
export const closeAttemptStarted = (attemptId: number): Promise<boolean> =>
  invoke("close_attempt_started", { attemptId });

export const cancelCloseAttempt = (attemptId: number): Promise<void> =>
  invoke("cancel_close_attempt", { attemptId });

/** Destroys the window if `attemptId` is still current. */
export const completeCloseAttempt = (attemptId: number): Promise<void> =>
  invoke("complete_close_attempt", { attemptId });

/** Write `<app_data_dir>/recovery/<suggestedName>`; resolves with the written path and size. */
export const writeRecoveryArtifact = (
  suggestedName: string,
  contents: string,
): Promise<{ path: string; size: number }> => invoke("write_recovery_artifact", { suggestedName, contents });
