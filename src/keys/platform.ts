export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const uad = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return /mac|iphone|ipad/i.test(uad?.platform || navigator.platform || "");
}
