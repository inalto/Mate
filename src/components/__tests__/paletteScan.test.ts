import { afterEach, describe, expect, it, vi } from "vitest";

const scan = vi.hoisted(() => ({ scanFromFilePicker: vi.fn() }));
vi.mock("../../scan/open", () => scan);
vi.mock("../../images/insert", () => ({ pickAndInsertImage: vi.fn() }));

import i18n from "../../i18n";
import { actionScore, QUICK_ACTIONS } from "../paletteActions";

afterEach(() => vi.clearAllMocks());

describe("insert.scan palette action", () => {
  const action = QUICK_ACTIONS.find((a) => a.id === "insert.scan")!;

  it("is an editor action with the scan synonyms and its own label", () => {
    expect(action.scope).toBe("editor");
    expect(action.synonyms).toEqual(["scan", "document", "photo", "camera", "straighten"]);
    expect(i18n.t(action.labelKey)).toBe("Scan a photo");
    expect(actionScore("straighten", action)).toBeGreaterThan(0);
  });

  it("opens the plain file picker", () => {
    action.run(vi.fn());
    expect(scan.scanFromFilePicker).toHaveBeenCalledTimes(1);
  });
});
