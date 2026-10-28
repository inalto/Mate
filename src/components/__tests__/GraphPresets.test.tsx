import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}), onSettingsChanged: vi.fn() }));

import GraphPresets from "../../overlay/GraphPresets";
import GraphsSection from "../../routes/Settings/sections/GraphsSection";
import { defaultGraphData, graphDataOf, type GraphData } from "../../graph/data";
import { applyPreset, presetFromData } from "../../graph/presets";
import { DEFAULT_SETTINGS } from "../../model/constants";
import type { GraphPreset } from "../../model/types";
import { useSettingsStore } from "../../stores/settings";

const presetsNow = (): GraphPreset[] => useSettingsStore.getState().settings.graphPresets;
const seed = (graphPresets: GraphPreset[]) => useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, graphPresets } });
const polarData = (): GraphData => ({ ...defaultGraphData(), kind: "2d-polar", grid: false });
const named = (name: string, data: GraphData, isDefault = false, withExprs = false): GraphPreset => ({ ...presetFromData(name, data, withExprs), isDefault });

beforeEach(() => seed([]));
afterEach(cleanup);

describe("GraphPresets row", () => {
  it("lists only presets of the graph's kind", () => {
    seed([named("Polar one", polarData()), named("Fn one", defaultGraphData())]);
    render(<GraphPresets kind="2d-function" data={defaultGraphData()} onApply={() => {}} />);
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toContain("Fn one");
    expect(options).not.toContain("Polar one");
  });

  it("applies the chosen preset", () => {
    const p = named("Fn one", { ...defaultGraphData(), grid: false });
    seed([p]);
    const onApply = vi.fn();
    render(<GraphPresets kind="2d-function" data={defaultGraphData()} onApply={onApply} />);
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Preset"), { target: { value: p.id } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith(p);
    expect(applyPreset(defaultGraphData(), p).grid).toBe(false);
  });

  it("saves the current setup under a name, with expressions when ticked", () => {
    const data = { ...polarData(), expressions: [{ id: "e", latex: "r=1", color: "#C62828", visible: true }] };
    render(<GraphPresets kind="2d-polar" data={data} onApply={() => {}} />);
    fireEvent.change(screen.getByLabelText("Preset name"), { target: { value: "Circle" } });
    fireEvent.click(screen.getByLabelText("Include expressions"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(presetsNow()).toHaveLength(1);
    expect(presetsNow()[0]).toMatchObject({ name: "Circle", kind: "2d-polar", grid: false, isDefault: false });
    expect(presetsNow()[0].expressions?.[0].latex).toBe("r=1");
  });

  it("saves without expressions by default and ignores a blank name", () => {
    render(<GraphPresets kind="2d-function" data={defaultGraphData()} onApply={() => {}} />);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Preset name"), { target: { value: "Plain" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(presetsNow()[0].expressions).toBeUndefined();
  });

  it("marking a default clears the other default of the kind, not of other kinds", () => {
    const a = named("A", defaultGraphData(), true);
    const b = named("B", defaultGraphData());
    const c = named("C", polarData(), true);
    seed([a, b, c]);
    render(<GraphPresets kind="2d-function" data={defaultGraphData()} onApply={() => {}} />);
    fireEvent.change(screen.getByLabelText("Preset"), { target: { value: b.id } });
    fireEvent.click(screen.getByLabelText("Default for new graphs of this kind"));
    expect(presetsNow().map((p) => [p.name, p.isDefault])).toEqual([["A", false], ["B", true], ["C", true]]);
  });

  it("deletes the chosen preset", () => {
    const a = named("A", defaultGraphData());
    seed([a]);
    render(<GraphPresets kind="2d-function" data={defaultGraphData()} onApply={() => {}} />);
    fireEvent.change(screen.getByLabelText("Preset"), { target: { value: a.id } });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(presetsNow()).toEqual([]);
  });
});

describe("Settings > Graphs", () => {
  it("groups presets by kind and renames and deletes", () => {
    const a = named("Fn one", defaultGraphData());
    const b = named("Polar one", polarData());
    seed([a, b]);
    render(<GraphsSection />);
    const fnGroup = screen.getByRole("group", { name: "Function graphs" });
    const polarGroup = screen.getByRole("group", { name: "Polar graphs" });
    expect(fnGroup.textContent).toContain("Fn one");
    expect(fnGroup.textContent).not.toContain("Polar one");
    expect(polarGroup.textContent).toContain("Polar one");
    expect(screen.queryByRole("group", { name: "Parametric graphs" })).toBeNull();

    fireEvent.click(fnGroup.querySelector("button")!); // Rename
    const input = screen.getByLabelText("Preset name");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(presetsNow().map((p) => p.name)).toEqual(["Renamed", "Polar one"]);

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[1]);
    expect(presetsNow().map((p) => p.name)).toEqual(["Renamed"]);
  });

  it("shows an empty hint", () => {
    render(<GraphsSection />);
    expect(screen.getByText(/No graph presets yet/)).toBeTruthy();
  });
});

describe("graph data stays valid after apply", () => {
  it("graphDataOf accepts an applied preset", () => {
    const p = named("P", polarData(), false, true);
    const out = applyPreset(defaultGraphData(), p);
    expect(graphDataOf({ content: { subtype: "graph", graphData: out } } as never).grid).toBe(false);
  });
});
