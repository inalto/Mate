// "Flash this group" requests: published by search results, rendered by the tutor overlay.
import { create } from "zustand";
import type { GroupBounds } from "../model/types";

export interface FlashRequest {
  pageId: string;
  groupId: string;
  /** The group's bounds when known; the overlay can look them up by id otherwise. */
  bounds?: GroupBounds;
  /** `Date.now()` of the request, so repeated flashes of one group are distinct. */
  at: number;
}

/** A flash older than this is dropped when read (no layer was there to show and clear it). */
export const FLASH_EXPIRY_MS = 5000;

/** The flash request if it is still fresh at `now`. */
export const freshFlash = (flash: FlashRequest | null, now = Date.now()): FlashRequest | null =>
  flash && now - flash.at <= FLASH_EXPIRY_MS ? flash : null;

interface FlashState {
  flash: FlashRequest | null;
  flashGroup(pageId: string, groupId: string, bounds?: GroupBounds): void;
  clearFlash(): void;
}

export const useFlashStore = create<FlashState>((set) => ({
  flash: null,
  flashGroup: (pageId, groupId, bounds) => set({ flash: { pageId, groupId, bounds, at: Date.now() } }),
  clearFlash: () => set({ flash: null }),
}));

/** Highlight a recognised group on its page (the page should be open or opening). */
export const flashGroup = (pageId: string, groupId: string, bounds?: GroupBounds): void =>
  useFlashStore.getState().flashGroup(pageId, groupId, bounds);
