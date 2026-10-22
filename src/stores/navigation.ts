// App-wide navigation for code outside React components (drop handlers, IPC events). The app
// registers the router's navigate once; until then navigation requests are dropped.
type Navigate = (path: string) => void;

let navigator: Navigate | null = null;

/** Register the function that changes the route (App does this with the router). */
export function setNavigator(fn: Navigate | null): void {
  navigator = fn;
}

/** Go to `path` (e.g. `/edit/<pageId>`). */
export function navigateTo(path: string): void {
  navigator?.(path);
}
