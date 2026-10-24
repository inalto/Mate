// The address rule of the AI settings, mirrored from Rust (`mate_core::ai::catalog`): a custom
// address must be https, unless it names this computer or the local network, and only such an
// address keeps handwriting on this computer / network.

/** The host of `url` in lower case (IPv6 without brackets), or null when it is not a URL. */
function hostOf(url: string): string | null {
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    return host.replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

/**
 * True when `url` names this computer or the local network: `localhost`, `*.localhost`, a
 * loopback address (`127.0.0.0/8`, `::1`) or a private IPv4 range (`10/8`, `172.16/12`,
 * `192.168/16`).
 */
export function isLocalHost(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** True when Mate accepts `url` as an AI address: empty (the default), https, or http on a local host. */
export function isAllowedAddress(url: string): boolean {
  const u = url.trim();
  if (u === "") return true;
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return false;
  }
  if (!parsed.hostname) return false;
  if (parsed.protocol === "https:") return true;
  return parsed.protocol === "http:" && isLocalHost(u);
}
