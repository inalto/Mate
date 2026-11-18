import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => []) }));
vi.mock("../../ipc/elementsQueue", () => ({
  elementsQueue: { enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}) },
}));

import { setPlatformForTests } from "../../platform";
import { useScanStore } from "../../scan/open";
import ScanMenu from "../ScanMenu";

const open = () => fireEvent.click(screen.getByRole("button", { name: "Scan" }));
const inputs = () => [...document.querySelectorAll<HTMLInputElement>("input[type=file]")];
const choose = (input: HTMLInputElement, file: File) => {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
};

afterEach(() => {
  cleanup();
  useScanStore.getState().close();
  setPlatformForTests(false);
  vi.restoreAllMocks();
});

describe("ScanMenu", () => {
  it("desktop offers From file and From webcam", () => {
    setPlatformForTests(false);
    render(<ScanMenu />);
    expect(screen.queryByRole("menu")).toBeNull();
    open();
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["From file…", "From webcam…"]);
  });

  it("mobile offers Take photo and Choose photo", () => {
    setPlatformForTests(true, "ios");
    render(<ScanMenu />);
    open();
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Take photo", "Choose photo"]);
  });

  it("From webcam opens the scan screen on the webcam", () => {
    render(<ScanMenu />);
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "From webcam…" }));
    expect(useScanStore.getState().request?.source).toBe("webcam");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("From file clicks an image input, and the chosen File opens the scan screen; the input is reset", () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    render(<ScanMenu />);
    const [file] = inputs();
    expect(file.accept).toBe("image/*");
    expect(file.hasAttribute("capture")).toBe(false);
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "From file…" }));
    expect(click).toHaveBeenCalledTimes(1);
    const photo = new File(["x"], "page.jpg", { type: "image/jpeg" });
    choose(file, photo);
    expect(useScanStore.getState().request?.source).toBe(photo);
    expect(file.value).toBe("");
  });

  it("on mobile Take photo uses the camera input and Choose photo the plain one", () => {
    setPlatformForTests(true, "ios");
    const clicked: HTMLInputElement[] = [];
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      clicked.push(this);
    });
    render(<ScanMenu />);
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "Take photo" }));
    expect(clicked[0].getAttribute("capture")).toBe("environment");
    expect(clicked[0].accept).toBe("image/*");
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "Choose photo" }));
    expect(clicked[1].hasAttribute("capture")).toBe(false);
    expect(clicked[1].accept).toBe("image/*");
    const photo = new File(["x"], "p.heic", { type: "image/heic" });
    choose(clicked[0], photo);
    expect(useScanStore.getState().request?.source).toBe(photo);
  });

  it("choosing nothing opens nothing", () => {
    render(<ScanMenu />);
    const [file] = inputs();
    Object.defineProperty(file, "files", { value: [], configurable: true });
    fireEvent.change(file);
    expect(useScanStore.getState().request).toBeNull();
  });
});
