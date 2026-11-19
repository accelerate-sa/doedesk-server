/**
 * Whose request this is: the address of the caller, and where the answer about its country may
 * come from.
 *
 * The service listens on the machine itself; the reverse proxy (Caddy) is the only thing meant to
 * connect to it, and it writes the caller's address at the end of `X-Forwarded-For`. That header
 * can be sent by anyone, so it is believed only when the connection comes from the proxy:
 *
 *   - the connection is from a trusted proxy (by default, this machine): the caller is the
 *     right-most entry of `X-Forwarded-For`, which is the one the proxy itself added. Entries to its
 *     left were sent by the caller and are ignored. No header: the caller is the proxy's own
 *     address (a request made on the machine, such as a health check);
 *   - the connection is from anywhere else: the caller is whoever connected, whatever headers it sent.
 *
 * During the days in which the Cloudflare Worker forwards requests here, the Worker states the
 * caller's address and country in its own headers. Those are believed only when the request also
 * carries the shared secret; without it they are dropped like any other claim.
 */
import { FORWARD_HEADERS } from "../src/maintenance.ts";
import { timingSafeEqual } from "../src/http.ts";
import { formatIp, inRange, isLoopback, parseIp } from "./ip.ts";

export interface Caller {
  /** The caller's address in canonical form, or "unknown" when it cannot be read. */
  readonly ip: string;
  /** Set when a trusted forwarder stated the country itself: two letters, or null for "not known". */
  readonly stated?: { readonly country: string | null; readonly region: string | null };
}

export interface TrustSettings {
  /** Addresses or blocks whose `X-Forwarded-For` is believed, besides this machine itself. */
  readonly trustedProxies: ReadonlyArray<string>;
  /** The secret the forwarding Worker sends. Empty: its headers are never believed. */
  readonly forwardSecret: string;
}

const isTrustedProxy = (peer: Uint8Array | null, settings: TrustSettings): boolean =>
  peer !== null && (isLoopback(peer) || settings.trustedProxies.some((range) => inRange(peer, range)));

export const resolveCaller = (headers: Headers, peerAddress: string, settings: TrustSettings): Caller => {
  const peer = parseIp(peerAddress);
  const viaProxy = isTrustedProxy(peer, settings);

  let caller = peer;
  if (viaProxy) {
    const forwarded = headers.get("x-forwarded-for");
    if (forwarded !== null) caller = parseIp(forwarded.split(",").at(-1) ?? "");
  }

  const secret = headers.get(FORWARD_HEADERS.secret) ?? "";
  if (viaProxy && settings.forwardSecret !== "" && secret !== "" && timingSafeEqual(secret, settings.forwardSecret)) {
    const stated = parseIp(headers.get(FORWARD_HEADERS.ip) ?? "");
    const country = (headers.get(FORWARD_HEADERS.country) ?? "").trim().toUpperCase();
    const region = (headers.get(FORWARD_HEADERS.region) ?? "").trim().toUpperCase();
    return {
      ip: stated === null ? "unknown" : formatIp(stated),
      stated: { country: /^[A-Z0-9]{2}$/.test(country) ? country : null, region: /^[A-Z0-9]{1,3}$/.test(region) ? region : null },
    };
  }
  return { ip: caller === null ? "unknown" : formatIp(caller) };
};
