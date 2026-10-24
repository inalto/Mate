import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/elementsQueue", () => ({
  elementsQueue: { enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}) },
}));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => []) }));
vi.mock("../../ipc/math", () => ({ wolframStatus: vi.fn(), wolframShortAnswer: vi.fn() }));
vi.mock("../cas", async (orig) => ({ ...(await orig<typeof import("../cas")>()), latexToPlain: vi.fn(async (l: string) => `plain(${l})`) }));

import ComputeMenu from "../../components/ComputeMenu";
import { useToastStore } from "../../components/Toast";
import { wolframShortAnswer, wolframStatus } from "../../ipc/math";
import { contentOf, type TextBoxContent } from "../../model/content";
import { DEFAULT_SETTINGS } from "../../model/constants";
import type { Element } from "../../model/types";
import { useEditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { useSettingsStore } from "../../stores/settings";
import { textAttrsOf } from "../../text/textBox";
import { latexToPlain } from "../cas";
import { useWolframItem, NEEDS_APPID, NEEDS_CONSENT } from "../useWolframItem";

const s = () => useEditorStore.getState();

async function mathBox(latex: string): Promise<Element> {
  useNotebookStore.setState({ loaded: true });
  await s().loadPage("pg");
  useEditorStore.setState({ viewport: { width: 1000, height: 800 } });
  const id = s().addMathBox()!;
  const el = s().elements.get(id)!;
  s().endEdit();
  s().updateElements([{ ...el, content: { ...(el.content as object), latex, textAttributes: { ...textAttrsOf(el) } } }]);
  s().select([id]);
  return s().elements.get(id)!;
}

function Menu({ source }: { source: Element }) {
  return <ComputeMenu store={useEditorStore} source={source} extraItems={useWolframItem()} />;
}

const open = () => fireEvent.click(screen.getByRole("button", { name: /Compute/ }));
const item = () => screen.getByRole("menuitem", { name: "Ask Wolfram|Alpha" }) as HTMLButtonElement;
const setConsent = (v: boolean) => useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, wolframConsent: v } });

describe("Ask Wolfram|Alpha item", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useToastStore.getState().dismiss();
    setConsent(true);
    vi.mocked(wolframStatus).mockResolvedValue({ configured: true, consent: true });
  });
  afterEach(cleanup);

  it("is disabled with a reason until an AppID is saved, then until consent is on", async () => {
    vi.mocked(wolframStatus).mockResolvedValue({ configured: false, consent: true });
    const src = await mathBox("2+2");
    render(<Menu source={src} />);
    await act(async () => {});
    open();
    expect(item().disabled).toBe(true);
    expect(item().title).toBe(NEEDS_APPID);
    cleanup();
    vi.mocked(wolframStatus).mockResolvedValue({ configured: true, consent: false });
    setConsent(false);
    render(<Menu source={src} />);
    await act(async () => {});
    open();
    expect(item().disabled).toBe(true);
    expect(item().title).toBe(NEEDS_CONSENT);
  });

  it("sends the plain text of the box and inserts the answer as a text box below it", async () => {
    vi.mocked(wolframShortAnswer).mockResolvedValue("about 5.4 million km");
    const src = await mathBox("\frac{1}{2}");
    render(<Menu source={src} />);
    await waitFor(() => {
      open();
      expect(item().disabled).toBe(false);
    });
    await act(async () => {
      fireEvent.click(item());
    });
    await waitFor(() => expect(s().elements.size).toBe(2));
    expect(latexToPlain).toHaveBeenCalledWith("\frac{1}{2}");
    expect(wolframShortAnswer).toHaveBeenCalledWith("plain(\frac{1}{2})");
    const made = [...s().elements.values()].find((e) => e.id !== src.id)!;
    expect(made.type).toBe("text-box");
    expect(contentOf<TextBoxContent>(made).rawContent).toBe("about 5.4 million km");
    expect([...s().selection]).toEqual([made.id]);
  });

  it("shows a refusal as a toast and adds nothing", async () => {
    vi.mocked(wolframShortAnswer).mockRejectedValue("Wolfram|Alpha has no short answer for this.");
    const src = await mathBox("x");
    render(<Menu source={src} />);
    await waitFor(() => {
      open();
      expect(item().disabled).toBe(false);
    });
    await act(async () => {
      fireEvent.click(item());
    });
    await waitFor(() => expect(useToastStore.getState().message).toBe("Wolfram|Alpha has no short answer for this."));
    expect(s().elements.size).toBe(1);
  });
});
