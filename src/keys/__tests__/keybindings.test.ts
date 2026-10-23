import { describe, expect, it } from "vitest";
import { ACTION_META, ACTIONS } from "../actions";
import {
  effectiveMap,
  findCollision,
  formatKeys,
  isReservedCombo,
  normalizeKeys,
  parseKeyEvent,
  toOverrides,
} from "../keybindings";

const ev = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("keybindings", () => {
  it("collision_is_rejected", () => {
    const map = effectiveMap([]);
    expect(findCollision(map, "Ctrl+Z", "redo")).toBe("undo");
    expect(findCollision(map, "ctrl+shift+z", "undo")).toBe("redo"); // spelling does not matter
    expect(findCollision(map, "Ctrl+Z", "undo")).toBeNull(); // its own binding is not a collision
    expect(findCollision(map, "Ctrl+Alt+Q", "undo")).toBeNull();
  });

  it("reserved_keys_cannot_be_bound", () => {
    for (const k of ["Escape", "Tab", "Enter", "Space", "P", "7", "Shift+P", "Ctrl+Tab", "Ctrl+Enter"]) {
      expect(isReservedCombo(k), k).toBe(true);
    }
    for (const k of ["Ctrl+P", "Alt+7", "F2", "Delete", "Ctrl+Space", "Alt+Space", "?"]) {
      expect(isReservedCombo(k), k).toBe(false);
    }
  });

  it("override_replaces_default_and_reset_restores", () => {
    const map = effectiveMap([{ action: "undo", keys: "Ctrl+J" }]);
    expect(map.undo).toEqual(["Ctrl+J"]);
    expect(map.redo).toEqual(ACTION_META.redo.defaultKeys);
    expect(toOverrides(map)).toEqual([{ action: "undo", keys: "Ctrl+J" }]);
    // Unbinding is an override with no keys.
    expect(effectiveMap([{ action: "undo", keys: "" }]).undo).toEqual([]);
    // Back at the defaults there is no override; unknown and fixed actions are ignored.
    expect(toOverrides(effectiveMap([]))).toEqual([]);
    expect(effectiveMap([{ action: "nope", keys: "Ctrl+J" }, { action: "pan", keys: "Ctrl+J" }]).pan).toEqual(["Space"]);
  });

  it("mac_formats_cmd", () => {
    expect(formatKeys("Ctrl+Shift+Z", true)).toBe("⇧⌘Z");
    expect(formatKeys("Alt+1", true)).toBe("⌥1");
    expect(formatKeys("Ctrl+Shift+Z", false)).toBe("Ctrl+Shift+Z");
    expect(formatKeys("Alt+ArrowLeft", false)).toBe("Alt+←");
  });

  it("parses_events_into_canonical_combos", () => {
    expect(parseKeyEvent(ev({ key: "z", code: "KeyZ", ctrlKey: true, shiftKey: true }), false)).toBe("Ctrl+Shift+Z");
    expect(parseKeyEvent(ev({ key: "z", code: "KeyZ", metaKey: true }), true)).toBe("Ctrl+Z");
    expect(parseKeyEvent(ev({ key: "z", code: "KeyZ", ctrlKey: true }), true)).toBeNull(); // raw Ctrl on a Mac
    expect(parseKeyEvent(ev({ key: "}", code: "BracketRight", ctrlKey: true, shiftKey: true }), false)).toBe("Ctrl+Shift+]");
    expect(parseKeyEvent(ev({ key: "?", code: "Slash", shiftKey: true }), false)).toBe("?");
    expect(parseKeyEvent(ev({ key: "Control", code: "ControlLeft", ctrlKey: true }), false)).toBeNull();
    expect(parseKeyEvent(ev({ key: " ", code: "Space" }), false)).toBe("Space");
    expect(normalizeKeys("shift+ctrl+k")).toBe("Ctrl+Shift+K");
  });

  it("defaults_have_no_collisions_and_cover_every_action", () => {
    const seen = new Map<string, string>();
    for (const a of ACTIONS) {
      for (const k of effectiveMap([])[a]) {
        expect(seen.get(k), `${k} used by ${a} and ${seen.get(k)}`).toBeUndefined();
        seen.set(k, a);
      }
    }
    expect(ACTIONS.length).toBe(Object.keys(ACTION_META).length);
  });
});
