// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
/**
 * How long each kind of data is kept. Every figure here is a promise made in the Privacy Policy
 * (`legal/privacy.en.md`, version 1.1) or follows from one, and the nightly job in retention.ts
 * enforces each of them. Change a figure here and in the policy together.
 *
 * Months are calendar months and days are 24 hours, both counted in UTC.
 */

/**
 * Privacy Policy 11: "Account and sign-in records: While the account exists; deleted on request, or
 * after 24 months without use."
 * Privacy Policy 4.1: "we delete accounts that have not been used for 24 months."
 * An account is unused when it was created, last signed in with, and last metered longer ago than
 * this. The policy promises no warning before the deletion, and none is sent.
 */
export const ACCOUNT_UNUSED_MONTHS = 24;

/**
 * A sign-in that has not been used for this long ends: it is refused when presented and removed by
 * the nightly job. Each day of use starts the period again, so an app in use stays signed in.
 * The policy gives sign-ins no period of their own (4.1 keeps them "while your account exists");
 * twelve months is the figure in `legal/notes.md` (plan item 10, "idle sessions") and keeps a sign-in
 * from outliving half of the account's own period. The policy should state it.
 */
export const SESSION_IDLE_MONTHS = 12;

/**
 * Privacy Policy 4.2 and 11: "Sign-in attempts: One day after they expire."
 * An acceptance of the Terms that came with an attempt nobody completed goes with it.
 */
export const SIGN_IN_ATTEMPT_DAYS_AFTER_EXPIRY = 1;

/**
 * Privacy Policy 11: "Rate-limit counters: Hours; up to two days for daily counters."
 * A counter is removed once its window and the one after it have passed.
 */
export const RATE_LIMIT_WINDOWS_KEPT = 2;

/**
 * Privacy Policy 4.3 and 11: "day-by-day detail for about 13 months (400 days, to the end of that
 * calendar month). After that only one total per account per month remains, kept while your account
 * exists and deleted with it."
 * The figure itself is `DAILY_RETENTION_DAYS` in usage.ts, where the roll-up lives.
 */

/** Privacy Policy 4.5 and 11: "App usage data: 400 days", "then deleted automatically". */
export const USAGE_DATA_DAYS = 400;

/** Privacy Policy 4.6 and 11: "Error reports: 180 days", "then deleted automatically". */
export const ERROR_REPORT_DAYS = 180;

/**
 * Privacy Policy 4.7 and 11: "Messages you send us: 12 months after the matter is closed."
 * The owner closes a matter on the dashboard.
 */
export const CONTACT_MAIL_MONTHS_AFTER_CLOSED = 12;

/**
 * A message the owner has not closed counts as closed this long after it arrived, so that the
 * twelve months above always start and no message is kept for ever because nobody pressed a button.
 * Ninety days covers the longest time the policy allows for an answer (section 13: 30 days, extended
 * once by up to 30) with a month to spare. The policy does not state this figure; it only ever
 * shortens what the policy allows.
 */
export const CONTACT_MAIL_AUTO_CLOSE_DAYS = 90;

/** Mail to the test mailboxes (e2e-…@doedesk.com) is not anyone's mail and goes after a day. */
export const TEST_MAIL_DAYS = 1;

/**
 * `legal/consent-spec.md` 5: "Keep it while the account exists and for five years after the account
 * is closed, then delete it."
 * This is the one thing that outlives a deleted account: the proof that its holder accepted the
 * Terms. The Privacy Policy does not yet say so (it should; see legal/service-changes-notes.md).
 */
export const ACCEPTANCE_YEARS_AFTER_CLOSURE = 5;

/**
 * Privacy Policy 4.7: "Records of rights requests are kept as long as the law requires."
 * The log holds a date, a kind, a channel, an outcome and an internal identifier, and no content.
 * Five years matches the period for the acceptance record; a Saudi lawyer should confirm it.
 */
export const RIGHTS_LOG_YEARS = 5;

/** How long a repeated DELETE /v1/me still gets its confirmation. No account data is in it. */
export const DELETION_RECEIPT_DAYS = 1;

/** How recently a session must have been verified by code or link to delete its account. */
export const DELETE_NEEDS_SIGN_IN_WITHIN_MINUTES = 10;
