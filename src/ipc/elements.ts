import { invoke } from "@tauri-apps/api/core";
import type { Element } from "../model/types";

export const loadElements = (pageId: string): Promise<Element[]> =>
  invoke("load_elements", { pageId });

export const upsertElements = (elements: Element[]): Promise<void> =>
  invoke("upsert_elements", { elements });

export const deleteElements = (ids: string[]): Promise<void> =>
  invoke("delete_elements", { ids });

/** Live elements of the unit's live pages created in [from, to] (RFC 3339), oldest first, without media. */
export const unitElementTimes = (unitId: string, from: string, to: string): Promise<{ id: string; pageId: string; createdAt: string }[]> =>
  invoke("unit_element_times", { unitId, from, to });
