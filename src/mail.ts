// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
/**
 * Mail sent to the service's addresses.
 *
 * A message to a contact address is stored, then forwarded to the owner's mailbox, so that a
 * privacy request reaches a person the day it is sent. The stored copy is what the dashboard
 * counts as unread and tracks until the matter is closed; the nightly job deletes it twelve months
 * after that (periods.ts).
 *
 * Forwarding needs two things outside this code:
 *   - `MAIL_FORWARD_TO` set on the Worker: the owner's mailbox, or several separated by commas;
 *   - each of those addresses added and verified under Email Routing, Destination addresses, in the
 *     Cloudflare account. Cloudflare refuses to forward to an address that is not verified.
 * If either is missing the message is still stored, and the dashboard says it was not forwarded.
 */
import { ApiError, type Env, json, nowIso, readJson, timingSafeEqual } from "./http.ts";
import { isFrozen } from "./maintenance.ts";

/** The public addresses. Mail to any other address at the domain is refused. */
export const CONTACT_ADDRESSES: ReadonlySet<string> = new Set([
  "hello@doedesk.com",
  "privacy@doedesk.com",
  "security@doedesk.com",
  "legal@doedesk.com",
]);

/** Mailboxes a test writes to and reads back. Kept a day. */
const TEST_ADDRESS = /^e2e-[a-z0-9]{8,40}@doedesk\.com$/;

const MAX_STORED_CHARACTERS = 200_000;

export const forwardAddresses = (env: Pick<Env, "MAIL_FORWARD_TO">): ReadonlyArray<string> =>
  (env.MAIL_FORWARD_TO ?? "")
    .split(/[\s,]+/)
    .map((address) => address.trim())
    .filter((address) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address));

/** A message as the service keeps it: who it was for, who sent it, its subject and its full text. */
export interface InboundMail {
  readonly to: string;
  readonly from: string;
  readonly subject: string;
  readonly raw: string;
}

export type MailKind = "test" | "contact" | "refused";

/** Which kind of address a message is for. Decided from the address alone. */
export const mailKind = (to: string): MailKind => {
  const address = to.toLowerCase();
  if (TEST_ADDRESS.test(address)) return "test";
  return CONTACT_ADDRESSES.has(address) ? "contact" : "refused";
};

/**
 * Stores a message. For a contact address the answer carries the row's identifier, so that what
 * became of the forwarding can be written beside it.
 */
export const storeMail = async (env: Env, mail: InboundMail): Promise<{ readonly kind: MailKind; readonly id: string | null }> => {
  const address = mail.to.toLowerCase();
  const kind = mailKind(address);
  if (kind === "refused") return { kind, id: null };
  if (kind === "test") {
    await env.DB.prepare("INSERT INTO test_inbox (address, received_at, raw) VALUES (?, ?, ?)")
      .bind(address, nowIso(), mail.raw.slice(0, MAX_STORED_CHARACTERS))
      .run();
    return { kind, id: null };
  }
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO contact_mail (id, address, sender, subject, received_at, raw) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, address, mail.from.slice(0, 320), mail.subject.slice(0, 300), nowIso(), mail.raw.slice(0, MAX_STORED_CHARACTERS))
    .run();
  return { kind, id };
};

/** Writes beside a stored message whether it reached the owner's mailbox: `failure` is null when it did. */
export const recordForward = async (env: Env, id: string, failure: string | null): Promise<void> => {
  await env.DB.prepare("UPDATE contact_mail SET forwarded_at = ?, forward_error = ? WHERE id = ?")
    .bind(failure === null ? nowIso() : null, failure === null ? null : failure.slice(0, 300), id)
    .run();
};

/** Hands the message to each of the owner's mailboxes. Null when all took it, else the last reason. */
const forward = async (message: ForwardableEmailMessage, env: Env): Promise<string | null> => {
  const destinations = forwardAddresses(env);
  let failure: string | null = destinations.length === 0 ? "MAIL_FORWARD_TO is not set" : null;
  for (const destination of destinations) {
    try {
      await message.forward(destination);
    } catch (cause) {
      // The reason goes to the dashboard. The log gets a marker only: an address is not logged.
      failure = (cause instanceof Error ? cause.message : String(cause)).slice(0, 300);
      console.error("mail_forward_failed");
    }
  }
  return failure;
};

/**
 * Mail arriving at the Worker (Cloudflare Email Routing).
 *
 * While the database is the Worker's own, the message is stored first, so that nothing the
 * forwarding does can lose it, and then forwarded.
 *
 * Once the database has moved (`MAIL_RELAY_URL` is set) the Worker keeps nothing: it forwards the
 * message, and posts the copy and what became of the forwarding to the API, which stores both. If
 * the API cannot be reached the owner still has the message; if neither worked the sending server
 * is told, so the sender learns the message did not arrive.
 *
 * While the service is frozen for a move, the message is forwarded and not stored.
 */
export const receiveMail = async (message: ForwardableEmailMessage, env: Env): Promise<void> => {
  const kind = mailKind(message.to);
  if (kind === "refused") {
    message.setReject("This address does not accept mail.");
    return;
  }
  const mail: InboundMail = {
    to: message.to.toLowerCase(),
    from: message.from,
    subject: message.headers.get("subject") ?? "",
    raw: (await new Response(message.raw).text()).slice(0, MAX_STORED_CHARACTERS),
  };

  if ((env.MAIL_RELAY_URL ?? "") !== "") {
    const failure = kind === "contact" ? await forward(message, env) : null;
    const relayed = await fetch(env.MAIL_RELAY_URL ?? "", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.MAIL_RELAY_KEY ?? ""}` },
      body: JSON.stringify({ ...mail, forwarded: kind === "contact" && failure === null, forwardError: failure }),
    }).then(
      (response) => response.ok,
      () => false,
    );
    if (!relayed) {
      console.error("mail_relay_failed");
      if (kind !== "contact" || failure !== null) throw new Error("The message could not be kept.");
    }
    return;
  }

  if (isFrozen(env)) {
    if (kind === "contact" && (await forward(message, env)) !== null) throw new Error("The message could not be kept.");
    return;
  }

  const stored = await storeMail(env, mail);
  if (stored.id !== null) await recordForward(env, stored.id, await forward(message, env));
};

/**
 * `POST /internal/inbound-mail`: a message the Worker received and relays here to be stored.
 * The route exists only where `MAIL_INGEST_KEY` is set, and takes nothing without that key.
 */
export const receiveRelayedMail = async (request: Request, env: Env): Promise<Response> => {
  const key = env.MAIL_INGEST_KEY ?? "";
  if (key === "") throw new ApiError(404, "not_found", "Not found.");
  const sent = request.headers.get("authorization") ?? "";
  if (!sent.startsWith("Bearer ") || !timingSafeEqual(sent.slice(7).trim(), key)) {
    throw new ApiError(401, "unauthenticated", "Mail key required.");
  }
  const body = await readJson(request);
  const { to, from, subject, raw } = body;
  if (typeof to !== "string" || typeof from !== "string" || typeof raw !== "string" || raw.length > 2 * MAX_STORED_CHARACTERS) {
    throw new ApiError(400, "invalid_request", "Send { to, from, subject, raw }.");
  }
  const stored = await storeMail(env, { to, from, subject: typeof subject === "string" ? subject : "", raw });
  if (stored.kind === "refused") throw new ApiError(422, "refused", "This address does not accept mail.");
  if (stored.id !== null) {
    const failure = body.forwarded === true ? null : typeof body.forwardError === "string" ? body.forwardError : "Not forwarded";
    await recordForward(env, stored.id, failure);
  }
  return json({ ok: true, kind: stored.kind });
};

/** Figures for the dashboard: how much mail waits, and whether any did not reach the owner. */
export const mailCounts = async (env: Env): Promise<{ readonly unread: number; readonly open: number; readonly notForwarded: number }> => {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END), 0) AS unread, " +
      "COALESCE(SUM(CASE WHEN closed_at IS NULL THEN 1 ELSE 0 END), 0) AS open, " +
      "COALESCE(SUM(CASE WHEN forwarded_at IS NULL AND closed_at IS NULL THEN 1 ELSE 0 END), 0) AS not_forwarded FROM contact_mail",
  ).first<{ unread: number; open: number; not_forwarded: number }>();
  return { unread: row?.unread ?? 0, open: row?.open ?? 0, notForwarded: row?.not_forwarded ?? 0 };
};
