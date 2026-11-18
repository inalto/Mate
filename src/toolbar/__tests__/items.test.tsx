import { describe, expect, it } from "vitest";
import i18n from "../../i18n";
import { ITEM_IDS } from "../layout";
import { ITEMS } from "../items";

describe("ITEMS", () => {
  it("every_item_id_has_a_catalogue_entry_with_a_translated_label", () => {
    for (const id of ITEM_IDS) {
      expect(ITEMS[id].id).toBe(id);
      expect(i18n.exists(ITEMS[id].label), `${id}: ${ITEMS[id].label}`).toBe(true);
    }
  });
});
