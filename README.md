# DoeDesk server

The server behind [DoeDesk](https://doedesk.com), at `https://api.doedesk.com`. The DoeDesk app
sends it text to find personal data in, and images and PDFs to read text from, before masking a
request to an AI model. It also holds accounts, sign-in, and usage counts.

It runs on one machine in Oracle Cloud, Jeddah, whose memory is encrypted by the processor
(AMD SEV-SNP). This repository is public so anyone can read what the server does with what it is
sent, and check that production runs this code.

## Never stored

Text sent for detection and files sent for reading are handled in memory, passed to a detection
engine on the same machine (at `ENGINE_URL`, called only from
[`src/engine.ts`](src/engine.ts)), and the answer goes back to the app. Nothing of the request,
the file or the answer is written to the database, a file or a log. The routes record counts only
([`src/usage.ts`](src/usage.ts), `meter`). [`server/test/nothing-kept.mjs`](server/test/nothing-kept.mjs)
checks this on a running server.

The adapter between this server and the engine, and the engine itself, are not in this
repository. For them you have our word: neither keeps nor logs any content, and a file sent for reading is
held in memory for at most five minutes.

## Stored

### Stored

All in one SQLite database on the machine ([`migrations/`](migrations) is the schema). How long
each is kept is in [`src/periods.ts`](src/periods.ts); the nightly job
([`src/retention.ts`](src/retention.ts)) deletes what is past its time.

| What | Table | Kept |
| --- | --- | --- |
| Account: email address or phone number, country at sign-up, sign-in method, two optional onboarding answers (field of work, workplace size) | `users` | Until deleted by its owner (`DELETE /v1/me`), or 24 months unused |
| Sign-ins: a hash of the token, app, device name, times | `sessions` | Until signed out, or 12 months idle |
| Sign-in attempts: email or phone, a hash of the code, app, country, city | `login_requests` | A day after they expire |
| Usage counts per account, day and app (see above) | `usage_daily`, then `usage` by month | 400 days daily, then monthly totals with the account |
| Acceptance of the Terms and Privacy Policy: versions, document hashes, time | `acceptances` | While the account exists and 5 years after |
| App usage events: the event's name and the properties the app attaches (at most 8 KB), app version, platform, country; under a random installation identifier, never an account (two kinds of event are dropped on arrival: [`src/ingest.ts`](src/ingest.ts)) | `events` | 400 days |
| The installation's choice about usage events | `usage_data_choices` | As events |
| Error reports from the app (message, technical detail, no free-form context) | `crash_reports` | 180 days |
| Mail sent to DoeDesk's contact addresses | `contact_mail` | 12 months after it is closed |
| Requests to export or delete data, and their outcome | `rights_requests`, `deletion_receipts` | 5 years; receipts 1 day |
| Rate-limit counters | `rate_limits` | Two windows |
| Mail to the test mailboxes the test suites use | `test_inbox` | 1 day |

Account holders can export everything held about them (`GET /v1/me/export`). Backups: an encrypted
copy of the database in Oracle Object Storage, Jeddah and Riyadh, kept 29 days. The service's
journal and the web server's request log are kept 7 days.

## Release records

Every deploy to production is signed and logged in [`releases/log/`](releases/log), and the
running release is served at `https://api.doedesk.com/v1/release`. To check it:

```sh
pnpm install
node server/ops/release.mjs verify
```

[`docs/releases.md`](docs/releases.md) explains what this proves and what it does not.

## Tests

```sh
pnpm install && pnpm run typecheck && node server/test/run-all.mjs
```

## Contact

This repository does not take issues or pull requests. Write to
[hello@doedesk.com](mailto:hello@doedesk.com).

## Licence

[AGPL-3.0-or-later](LICENSE).
