import { invoke } from "@tauri-apps/api/core";
import type { RecallAnswer, RecallPageStats, RecallUnitStats } from "../model/types";

/** Stores one answer of a cover study run. Rejects an empty element or run id. */
export const recordRecall = (answer: RecallAnswer): Promise<void> => invoke("record_recall", { answer });

export const recallPageStats = (pageId: string): Promise<RecallPageStats> => invoke("recall_page_stats", { pageId });

export const recallUnitStats = (unitId: string): Promise<RecallUnitStats> => invoke("recall_unit_stats", { unitId });

/** The latest `last` answers for one cover, oldest first (`true` = knew it). */
export const recallElementHistory = (elementId: string, last: number): Promise<boolean[]> =>
  invoke("recall_element_history", { elementId, last });
