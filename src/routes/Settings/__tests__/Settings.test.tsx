import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../../model/constants";

vi.mock("../../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../../ipc/ai", () => ({
  getAiStatus: vi.fn(async () => ({ configured: false, provider: "anthropic", model: "claude-opus-5-5", consent: false })),
  setAiKey: vi.fn(),
  clearAiKey: vi.fn(),
  testAiKey: vi.fn(),
  listAiProviders: vi.fn(async () => [{ id: "anthropic", label: "Anthropic", group: "cloud", needsKey: true, editableBaseUrl: false, defaultBaseUrl: "", defaultModel: "claude-opus-5-5", vision: "yes", canListModels: false, keyUrl: "", cost: "paid", privacy: "sentTo" }]),
  listAiModels: vi.fn(async () => []),
}));
vi.mock("../../../ipc/math", () => ({ wolframStatus: vi.fn(async () => ({ configured: false, consent: false })) }));
vi.mock("../../../ipc/speech", () => ({
  listSpeechProviders: vi.fn(async () => [{ id: "openai", label: "OpenAI", needsKey: true, editableBaseUrl: false, defaultBaseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini-transcribe", keyUrl: "", local: false }]),
  getSpeechStatus: vi.fn(async () => ({ configured: false, hasKey: false, provider: "openai", model: "gpt-4o-mini-transcribe", baseUrl: "", consent: false, needsKey: true, local: false })),
  setSpeechKey: vi.fn(),
  clearSpeechKey: vi.fn(),
  transcribeAudio: vi.fn(),
}));
vi.mock("../../../ipc/backup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../ipc/backup")>()),
  exportBackup: vi.fn(async () => ({ path: "C:/tmp/mate-backup-2026-10-23.zip", skipped: [] })),
  resetLocalData: vi.fn(async () => {}),
}));
vi.mock("../../../ipc/share", () => ({
  nextcloudStatus: vi.fn(async () => ({ signedIn: false, server: "", user: "" })),
  nextcloudLoginStart: vi.fn(),
  nextcloudLoginPoll: vi.fn(),
  nextcloudLogout: vi.fn(),
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "9.9.9") }));

import { exportBackup, resetLocalData } from "../../../ipc/backup";
import { setPlatformForTests } from "../../../platform";
import { useSettingsStore } from "../../../stores/settings";
import { PENDING_WIRING } from "../pendingWiring";
import { collectEntries, fuzzyScore, searchEntries } from "../search";
import Settings from "../index";

const cfg = () => useSettingsStore.getState().settings;
const renderPane = () =>
  render(
    <MemoryRouter>
      <Settings />
    </MemoryRouter>,
  );

const realUpdate = useSettingsStore.getState().update;
beforeEach(() => useSettingsStore.setState({ settings: DEFAULT_SETTINGS, loaded: true, update: realUpdate }));
afterEach(() => {
  cleanup();
  setPlatformForTests(false);
  vi.useRealTimers();
  vi.clearAllMocks();
});

/** Fire a slider/colour change and let the 250 ms debounce write it. */
const drag = (label: string, value: string) => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
  act(() => void vi.advanceTimersByTime(250));
};

describe("Settings rows", () => {
  beforeEach(() => vi.useFakeTimers());

  it("ink_to_shape_and_scribble_rows_update_settings", () => {
    renderPane();
    const toShape = screen.getByLabelText("Ink to shape") as HTMLInputElement;
    expect(toShape.checked).toBe(true);
    fireEvent.click(toShape);
    expect(cfg().inkToShape).toBe(false);
    fireEvent.click(screen.getByLabelText("Snap when lifting the pen"));
    expect(cfg().inkToShapeSnapsOnRelease).toBe(true);
    const dwell = screen.getByLabelText("Hold time") as HTMLInputElement;
    expect(dwell.min).toBe("300");
    expect(dwell.max).toBe("2000");
    drag("Hold time", "1200");
    expect(cfg().inkToShapeDwellMs).toBe(1200);
    fireEvent.click(screen.getByLabelText("Scribble to erase"));
    expect(cfg().scribbleToErase).toBe(false);
    fireEvent.change(screen.getByLabelText("Scribble sensitivity"), { target: { value: "more" } });
    expect(cfg().scribbleEraseSensitivity).toBe("more");
  });

  it("invert_images_toggle_updates_setting", () => {
    renderPane();
    const box = screen.getByLabelText("Invert images in dark mode") as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(cfg().invertImagesInDarkMode).toBe(false);
  });

  it("text_shape_and_eraser_defaults_update_settings", () => {
    renderPane();
    drag("Text colour", "#aa0000");
    expect(cfg().defaultTextColor).toBe("#aa0000");
    drag("Text size", "30");
    expect(cfg().defaultTextSize).toBe(30);
    fireEvent.change(screen.getByLabelText("Shape type"), { target: { value: "star" } });
    expect(cfg().defaultShapeType).toBe("star");
    drag("Shape stroke colour", "#00aa00");
    expect(cfg().defaultShapeStrokeColor).toBe("#00aa00");
    drag("Shape fill colour", "#0000aa");
    expect(cfg().defaultShapeFillColor).toBe("#0000aa");
    drag("Shape width", "6");
    expect(cfg().defaultShapeStrokeWidth).toBe(6);
    drag("Shape fill opacity", "0.5");
    expect(cfg().defaultShapeFillOpacity).toBe(0.5);
    fireEvent.change(screen.getByLabelText("Eraser type"), { target: { value: "partial" } });
    expect(cfg().defaultEraserType).toBe("partial");
    drag("Eraser width", "40");
    expect(cfg().defaultEraserWidth).toBe(40);
    fireEvent.click(screen.getByLabelText("Erase shapes"));
    expect(cfg().eraserEraseShapes).toBe(!DEFAULT_SETTINGS.eraserEraseShapes);
    fireEvent.click(screen.getByLabelText("Erase images"));
    expect(cfg().eraserEraseImages).toBe(!DEFAULT_SETTINGS.eraserEraseImages);
  });

  it("new_input_rows_update_settings", () => {
    renderPane();
    fireEvent.change(screen.getByLabelText("Palm rejection"), { target: { value: "standard" } });
    expect(cfg().palmRejection).toBe("standard");
    fireEvent.change(screen.getByLabelText("Barrel button"), { target: { value: "lasso" } });
    expect(cfg().penBarrelButtonAction).toBe("lasso");
    fireEvent.change(screen.getByLabelText("Mouse wheel"), { target: { value: "zoom" } });
    expect(cfg().scrollBehavior).toBe("zoom");
    fireEvent.change(screen.getByLabelText("One finger"), { target: { value: "pan" } });
    expect(cfg().fingerAction).toBe("pan");
    fireEvent.change(screen.getByLabelText("Keep deleted items for"), { target: { value: "0" } });
    expect(cfg().trashRetentionDays).toBe(0);
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(cfg().theme).toBe("dark");
  });

  it("tutor_rows_update_settings", () => {
    renderPane();
    expect(screen.getByRole("heading", { name: "Tutor & recognition" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Tutor interactions" })).toBeTruthy();
    const mode = screen.getByLabelText("When to check") as HTMLSelectElement;
    expect(mode.value).toBe("live");
    fireEvent.change(mode, { target: { value: "onask" } });
    expect(cfg().tutorMode).toBe("onask");
    const rows: Array<[string, keyof typeof DEFAULT_SETTINGS]> = [
      ["Tutor", "tutorEnabled"],
      ["Underline mistakes", "tutorUnderlineErrors"],
      ["Tick correct work", "correctnessMode"],
      ["Show when checking", "tutorShowChecking"],
      ["Double-tap ink to ask", "tutorDoubleTapAsk"],
      ["Hold the pen on ink to ask", "tutorHoldToAsk"],
    ];
    for (const [label, key] of rows) {
      const box = screen.getByLabelText(label) as HTMLInputElement;
      const before = cfg()[key];
      expect(box.checked).toBe(before);
      fireEvent.click(box);
      expect(cfg()[key]).toBe(!before);
    }
    expect(document.body.textContent).not.toMatch(/derive/i);
  });

  it("shows_the_ai_settings_off_by_default", async () => {
    vi.useRealTimers();
    renderPane();
    expect(((await screen.findByLabelText(/Nothing is sent until you turn this on/)) as HTMLInputElement).checked).toBe(false);
    // The tutor's key status (Dictation shows its own).
    const tutor = document.getElementById("set-sec-tutor") as HTMLElement;
    expect(await within(tutor).findByText("No key")).toBeTruthy();
  });
});

describe("sliders", () => {
  beforeEach(() => vi.useFakeTimers());

  it("sliders_debounce_writes", () => {
    const update = vi.fn(async () => {});
    useSettingsStore.setState({ update });
    renderPane();
    const slider = screen.getByLabelText("Pen width") as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "5" } });
    act(() => void vi.advanceTimersByTime(100));
    fireEvent.change(slider, { target: { value: "6" } });
    act(() => void vi.advanceTimersByTime(100));
    fireEvent.change(slider, { target: { value: "7" } });
    expect(slider.value).toBe("7"); // shown at once
    expect(update).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(249));
    expect(update).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ defaultPenWidth: 7 });
  });

  it("flushes_a_pending_slider_write_on_unmount", () => {
    const update = vi.fn(async () => {});
    useSettingsStore.setState({ update });
    const { unmount } = renderPane();
    fireEvent.change(screen.getByLabelText("Eraser width"), { target: { value: "55" } });
    unmount();
    expect(update).toHaveBeenCalledWith({ defaultEraserWidth: 55 });
  });
});

describe("search", () => {
  it("finds_the_dictation_section", async () => {
    renderPane();
    await screen.findByLabelText("Speech service");
    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "Dictation" } });
    const results = screen.getByRole("list", { name: "Search results" });
    expect(within(results).getAllByRole("button").some((b) => b.textContent?.includes("Dictation"))).toBe(true);
    expect(screen.getByRole("button", { name: "Dictation" })).toBeTruthy();
  });

  it("fuzzy_scoring_prefers_substrings_and_rejects_non_subsequences", () => {
    expect(fuzzyScore("palm", "Palm rejection")).toBeGreaterThan(fuzzyScore("pmr", "Palm rejection"));
    expect(fuzzyScore("pmrj", "Palm rejection")).toBeGreaterThan(0);
    expect(fuzzyScore("xyz", "Palm rejection")).toBe(-1);
    const entries = [
      { id: "a", label: "Pen width", section: "Pen & stylus", sectionId: "pen" },
      { id: "b", label: "Palm rejection", section: "Gestures & touch", sectionId: "gestures" },
    ];
    expect(searchEntries("palm", entries).map((e) => e.id)).toEqual(["b"]);
    expect(searchEntries("gestures", entries).map((e) => e.id)).toEqual(["b"]);
  });

  it("search_jumps_and_flashes_row", () => {
    vi.useFakeTimers();
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    renderPane();
    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "palm rej" } });
    const results = screen.getByRole("list", { name: "Search results" });
    fireEvent.click(within(results).getByRole("button", { name: /Palm rejection/ }));
    const row = document.querySelector('[data-row-id="set-palmRejection"]') as HTMLElement;
    expect(scroll).toHaveBeenCalled();
    expect(row.classList.contains("srow-flash")).toBe(true);
    act(() => void vi.advanceTimersByTime(1499));
    expect(row.classList.contains("srow-flash")).toBe(true);
    act(() => void vi.advanceTimersByTime(1));
    expect(row.classList.contains("srow-flash")).toBe(false);
    // the section nav follows the jump
    expect(screen.getByRole("button", { name: "Gestures & touch" }).getAttribute("aria-current")).toBe("location");
  });

  it("enter_in_the_search_box_jumps_to_the_best_hit", () => {
    vi.useFakeTimers();
    renderPane();
    const box = screen.getByLabelText("Search settings");
    fireEvent.change(box, { target: { value: "barrel" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(document.querySelector('[data-row-id="set-penBarrelButtonAction"]')?.classList.contains("srow-flash")).toBe(true);
  });
});

describe("navigation and landmarks", () => {
  it("has_nav_and_content_landmarks_and_every_section", () => {
    renderPane();
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(screen.getByRole("region", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("search")).toBeTruthy();
    for (const g of ["General", "Appearance", "Writing", "Intelligence", "System"]) {
      expect(within(nav).getByRole("group", { name: g })).toBeTruthy();
    }
    for (const s of [
      "General",
      "Theme",
      "Paper & layout",
      "Pen & stylus",
      "Pen buttons",
      "Gestures & touch",
      "Tutor & recognition",
      "Tutor interactions",
      "Maths engines",
      "Keyboard shortcuts",
      "Trash",
      "Backup",
      "Sharing",
      "Updates",
      "About",
    ]) {
      expect(within(nav).getByRole("button", { name: s })).toBeTruthy();
      expect(screen.getByRole("heading", { level: 2, name: s })).toBeTruthy();
    }
    expect(screen.queryAllByText("Coming in this release")).toHaveLength(0);
    expect(document.querySelector(".keybindings")).not.toBeNull();
  });

  it("arrow_keys_move_between_nav_items", () => {
    renderPane();
    const general = screen.getAllByRole("button", { name: "General" })[0];
    general.focus();
    fireEvent.keyDown(general, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Theme" }));
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" });
    expect(document.activeElement).toBe(general);
    fireEvent.keyDown(general, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "About" }));
  });

  it("clicking_a_nav_item_scrolls_to_its_section", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    renderPane();
    fireEvent.click(screen.getByRole("button", { name: "Backup" }));
    expect(scroll).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Backup" }).getAttribute("aria-current")).toBe("location");
  });

  it("opens_at_the_section_named_in_the_address", () => {
    const scroll = vi.fn(function (this: Element) {
      return this;
    });
    Element.prototype.scrollIntoView = scroll;
    render(
      <MemoryRouter initialEntries={["/settings#sharing"]}>
        <Settings />
      </MemoryRouter>,
    );
    expect(scroll.mock.contexts.some((el) => (el as Element).id === "set-sec-sharing")).toBe(true);
    expect(screen.getByRole("button", { name: "Sharing" }).getAttribute("aria-current")).toBe("location");
  });
});

describe("about and backup", () => {
  it("about_shows_the_version_and_welcome_again_resets_onboarding", async () => {
    renderPane();
    expect(await screen.findByText("9.9.9")).toBeTruthy();
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, onboardingDone: true } });
    fireEvent.click(screen.getByRole("button", { name: "Show welcome again" }));
    expect(cfg().onboardingDone).toBe(false);
  });

  it("download_backup_calls_the_export_and_reports_the_path", async () => {
    renderPane();
    fireEvent.click(screen.getByRole("button", { name: "Download backup" }));
    expect(await screen.findByText(/mate-backup-2026-10-23\.zip/)).toBeTruthy();
    expect(exportBackup).toHaveBeenCalledTimes(1);
  });

  it("download_backup_names_the_books_it_left_out", async () => {
    vi.mocked(exportBackup).mockResolvedValueOnce({
      path: "C:/tmp/mate-backup-2026-10-24.zip",
      skipped: [{ unitId: "u9", title: "Films", reason: "left out of the backup: larger than 512 MiB" }],
    });
    renderPane();
    fireEvent.click(screen.getByRole("button", { name: "Download backup" }));
    expect(await screen.findByText(/mate-backup-2026-10-24\.zip/)).toBeTruthy();
    expect(screen.getByText("Films: left out of the backup: larger than 512 MiB")).toBeTruthy();
  });

  it("reset_local_data_requires_confirmation", async () => {
    renderPane();
    fireEvent.click(screen.getByRole("button", { name: "Reset local data" }));
    expect(resetLocalData).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain(
      "Reset local data?This deletes all books, pages and settings on this device. A backup zip is written first. API keys stored in the system keychain, or the app's private key file on Android, are kept.",
    );
    // Cancel does nothing.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(resetLocalData).not.toHaveBeenCalled();
    // Confirm resets.
    fireEvent.click(screen.getByRole("button", { name: "Reset local data" }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Reset" }));
    });
    expect(resetLocalData).toHaveBeenCalledTimes(1);
  });

  it("reset_refused_for_a_too_large_book_shows_why", async () => {
    const why =
      "Nothing was reset: “Films” could not be included in the recovery backup (left out of the backup: larger than 512 MiB). Export or delete these books first, then reset again.";
    vi.mocked(resetLocalData).mockRejectedValueOnce(why);
    renderPane();
    fireEvent.click(screen.getByRole("button", { name: "Reset local data" }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Reset" }));
    });
    expect(screen.getByRole("alert").textContent).toBe(why);
    expect((screen.getByRole("button", { name: "Reset local data" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("reset_on_mobile_says_mate_will_close", () => {
    setPlatformForTests(true);
    renderPane();
    fireEvent.click(screen.getByRole("button", { name: "Reset local data" }));
    expect(screen.getByRole("alertdialog").textContent).toContain("then Mate closes. Reopen it to start again.");
  });
});

describe("settings keys", () => {
  it("settings_keys_are_consumed", async () => {
    renderPane();
    const keys = [...new Set([...document.querySelectorAll("[data-setting-key]")].map((e) => (e as HTMLElement).dataset.settingKey ?? ""))];
    expect(keys.length).toBeGreaterThan(30);
    // Everything under src/ except this pane, the model files that merely declare keys, and tests.
    const sources = import.meta.glob(
      ["/src/**/*.{ts,tsx}", "!/src/routes/Settings/**", "!/src/model/**", "!/src/**/__tests__/**", "!/src/**/*.test.{ts,tsx}"],
      { query: "?raw", import: "default", eager: true },
    ) as Record<string, string>;
    const text = Object.values(sources).join("\n");
    const unread = keys.filter((k) => !PENDING_WIRING.has(k) && !new RegExp(`\\b${k}\\b`).test(text));
    expect(unread, `rendered settings nothing reads: ${unread.join(", ")}`).toEqual([]);
    // The pending list must not rot: a key listed there is rendered, and not yet read.
    const stale = [...PENDING_WIRING].filter((k) => !keys.includes(k) || new RegExp(`\\b${k}\\b`).test(text));
    expect(stale, `PENDING_WIRING entries now wired or not rendered: ${stale.join(", ")}`).toEqual([]);
  });

  it("every_row_is_indexed_for_search", () => {
    renderPane();
    const entries = collectEntries(document.body);
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(entries.every((e) => e.label && e.section)).toBe(true);
  });
});
