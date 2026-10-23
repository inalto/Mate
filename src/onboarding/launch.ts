// Launch-time decisions: first-run welcome and the once-per-version What's new.
import type { Settings } from "../model/types";

/** The welcome flow shows until it is finished or skipped. */
export const shouldShowWelcome = (s: Pick<Settings, "onboardingDone">): boolean => !s.onboardingDone;

/**
 * What to do with release notes at launch. `onboardingDoneAtLaunch` is the value before this
 * launch: on a first run nothing is shown, the version is just remembered.
 */
export function whatsNewAction(
  s: Pick<Settings, "lastSeenVersion">,
  onboardingDoneAtLaunch: boolean,
  appVersion: string,
): "show" | "remember" | "none" {
  if (s.lastSeenVersion === appVersion) return "none";
  return onboardingDoneAtLaunch ? "show" : "remember";
}
