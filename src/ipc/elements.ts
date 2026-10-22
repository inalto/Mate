import { invoke } from "@tauri-apps/api/core";
import type { Element } from "../model/types";

export const loadElements = (pageId: string): Promise<Element[]> =>
  invoke("load_elements", { pageId });

export const upsertElements = (elements: Element[]): Promise<void> =>
  invoke("upsert_elements", { elements });

export const deleteElements = (ids: string[]): Promise<void> =>
  invoke("delete_elements", { ids });
