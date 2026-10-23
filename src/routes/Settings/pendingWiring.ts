/**
 * Settings that have a row in the pane but no reader elsewhere in `src/` yet. The test
 * `settings_keys_are_consumed` fails for any other rendered key nothing reads, so a row cannot
 * ship as a dead switch by accident. Remove a key from this set when its consumer lands.
 */
export const PENDING_WIRING: ReadonlySet<string> = new Set<string>([]);
