import { describe, expect, it } from "vitest";
import fixture from "../../../../crates/mate-core/tests/fixtures/settings-defaults.json";
import { DEFAULT_SETTINGS } from "../../../model/constants";

describe("settings defaults fixture", () => {
  it("settings_defaults_fixture_matches_ts_defaults", () => {
    // Regenerate with `npm run dump:settings-defaults`; the Rust test compares the same file.
    expect(fixture).toEqual(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
  });
});
