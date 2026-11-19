# Settings of the DoeDesk Cloud server

Every setting the server reads, where its value comes from, and which file on the machine holds it.
No value is written here or anywhere in the repository.

All files are in `/etc/doedesk/`, owned by root, mode 600. systemd reads them and hands the values to
the service, which runs as the user `doedesk` and cannot open them itself.

To change one: edit the file as root, then `sudo systemctl restart doedesk-api` (the API finishes the
requests it has first).

## `/etc/doedesk/api.env`: the API

`server/ops/api.env.example` is the same list with empty values.

### Required

| Setting | What it is | Where the value comes from |
| --- | --- | --- |
| `DOEDESK_ENV` | `production`. The other stages are `rehearsal` (a machine with a copy of the data) and `test` (the test suites) | Typed |
| `JWT_PRIVATE_JWK` | The ES256 private key, as a JWK, that signs the short-lived tokens DoeDesk Connect accepts. The same key the Worker has, so tokens keep verifying across the move | Copied from the Worker's secret at the switch. See "Secrets that cannot be read back" below |
| `ADMIN_KEY` | Opens the owner's dashboard (`/admin`). At least 24 characters | The password manager, item "DoeDesk Admin Key". Make a new one at the switch |
| `AUTHENTICA_API_KEY` | Sends sign-in codes by SMS | The password manager, item "Authentica API Key" |
| `SMTP_HOST` | `smtp.email.me-jeddah-1.oci.oraclecloud.com` | Typed |
| `SMTP_PORT` | `587` | Typed |
| `SMTP_USERNAME`, `SMTP_PASSWORD` | An SMTP credential of the Oracle admin user (no user was made for this) | Made in Oracle and written straight here; the runbook says how to revoke and rotate it |

### Detection and reading

Detection and reading have one place to go: the engine on this machine. There is no other path
and no fallback; when the engine is down, detection and reading fail.

| Setting | What it is | Where the value comes from |
| --- | --- | --- |
| `ENGINE_URL` | Required. The engine on this machine: `http://127.0.0.1:8080` | Typed |
| `ENGINE_TOKEN` | Sent to the engine as a bearer token, if it was started with a token | The same value as the engine's |
| `ENGINE_PRICE_PER_1000_UNITS` | Optional. What the engine costs, in US dollars, per 1,000 engine units (the units of work the engine reports for each detection call). For the owner's dashboard only | The operator's own figure |
| `ENGINE_PRICE_PER_1000_PAGES` | Optional. The same per 1,000 pages read | As above |

With neither price set, the dashboard shows no cost anywhere (the accounts table and its CSV have no
cost column, and the account and spread pages no cost tiles). With one set, the other counts as free.

### Rules (optional; the same meaning as on the Worker)

| Setting | Values | Effect |
| --- | --- | --- |
| `REQUIRE_ACCEPTANCE` | unset, `signup`, `all` | Whether accepting the Terms is required to sign in, and to use detection and reading |
| `SIGNUP_BLOCKED_COUNTRIES` | Codes separated by commas: `IR`, or a region such as `UA-43` | No new account from there. A region can be matched only where the country file carries regions: Canada and four regions of Ukraine |
| `SIGNUP_BLOCK_EU_UK` | `1` | No new account from the EU, the EEA and the United Kingdom |
| `USAGE_DATA_RANDOM_IDENTIFIERS_ONLY` | `1` | Usage events are stored only under a random identifier |

`EXPOSE_LOGIN_SECRETS` must never be set in production: it returns sign-in codes to the caller. The
server refuses to start in the `production` stage if it is set.

### The move (optional)

| Setting | What it is |
| --- | --- |
| `CONFIRM_ORIGIN` | Where the emailed sign-in link opens. Set to `https://api.doedesk.com` once that name points at this machine. Unset, links open on `https://doedesk.com`, which the Worker passes on |
| `MAIL_INGEST_KEY` | The key the Cloudflare Worker presents when it hands over contact mail (`POST /internal/inbound-mail`). At least 32 characters. The same value as the Worker's `MAIL_RELAY_KEY`. Unset, the route does not exist |
| `FORWARD_SECRET` | The secret the forwarding Worker presents, for the days it is in front. At least 32 characters. The same value as the Worker's `FORWARD_SECRET`. Remove it when the Worker no longer forwards |
| `MAINTENANCE` | `freeze`: nothing is written. For the minutes of a move only |

### Alerts (optional)

| Setting | What it is |
| --- | --- |
| `ALERT_EMAIL` | Where the machine writes when a unit fails. Unset, a failure only shows in `systemctl --failed` |
| `ALERT_FROM` | The sender of that email: an approved sender in Oracle Email Delivery. `signin@doedesk.com` unless set |

### Tuning (optional; defaults shown)

| Setting | Default | What it is |
| --- | --- | --- |
| `DOEDESK_READING_AT_ONCE` | `4` | Documents read at the same time. One more is told to try again in a moment |
| `DOEDESK_SHUTDOWN_SECONDS` | `130` | How long a stop waits for requests in flight |
| `DOEDESK_GEO_MAX_AGE_DAYS` | `100` | A country file older than this is not used: every caller's country is "not known" |
| `DOEDESK_TRUSTED_PROXIES` | none | Addresses or blocks, besides this machine itself, whose `X-Forwarded-For` is believed |
| `DOEDESK_MAX_BODY_BYTES` | `22020096` | The largest request body taken (21 MB) |

### Set by the unit file, not here

`DOEDESK_DATABASE=/var/lib/doedesk/doedesk.sqlite`, `DOEDESK_GEO_FILE=/var/lib/doedesk/geo/country.ddgeo`,
`DOEDESK_HOST=127.0.0.1`, `DOEDESK_PORT=8787`. Change them in `doedesk-api.service` if the layout changes.

## `/etc/doedesk/backup.env`: the backups

None of these is a secret. The machine signs in to Oracle as itself (an instance principal), so
there is no key for the buckets.

| Setting | What it is | Where the value comes from |
| --- | --- | --- |
| `BACKUP_NAMESPACE` | The tenancy's Object Storage namespace | `oci os ns get` |
| `BACKUP_COMPARTMENT` | OCID of the compartment the buckets are in | The `doedesk` compartment |
| `BACKUP_REGION` | `me-jeddah-1` | Typed |
| `REPLICA_BUCKET` | `doedesk-db-replica`: where the continuous copy goes, once a minute | Typed |
| `SNAPSHOT_BUCKET` | `doedesk-snapshots`: where the nightly snapshot goes | Typed |
| `SNAPSHOT_AGE_RECIPIENT` | The public key snapshots are encrypted to (`age1…`) | Made with `age-keygen` on the owner's computer. The private half goes in the password manager and never on the machine |
| `SNAPSHOT_UPLOAD_URL` | Instead of `SNAPSHOT_BUCKET`, on a machine that is not an Oracle instance: an upload address that can only add objects | A pre-authenticated request, ending in `/o/` |
| `REPLICA_PREFIX` | The folder in the replica bucket. Unset (`doedesk`) in production. A rehearsal machine sets another, such as `rehearsal-cc`, so that it never writes over production's copy: the bucket's policy cannot tell the folders apart | Typed; removed at the switch |
| `SNAPSHOT_PREFIX` | Put before each snapshot's name, ending in `/`. Unset in production; `rehearsal-cc/` on a rehearsal machine, so its snapshots are told apart | Typed; removed at the switch |

## `/etc/doedesk/check.env`: the self-check (optional)

`CHECK_MIN_FREE_MB` (default 2048), `CHECK_REPLICATION` and `CHECK_SNAPSHOT` (default 1; 0 turns the
check off, for a machine that has no backups configured yet), `CHECK_REBOOT_DAYS` (default 7: a
reboot for a security update waiting longer is a problem; on the confidential VM, which never
reboots itself, this is the reminder; 0 turns it off).

## `/etc/caddy/doedesk.env`: Caddy

| Setting | What it is |
| --- | --- |
| `DOEDESK_SITE` | The name or names Caddy answers as: `api.doedesk.com`, or `api-origin.doedesk.com api.doedesk.com` for the days both exist |
| `DOEDESK_TLS` | `public` (the default), or `internal` for a rehearsal with no public name |
| `ACME_EMAIL` | Where the certificate authority may write about expiry |

## Secrets that cannot be read back

Cloudflare does not show a Worker secret once it is set. Two values exist only there:

- `JWT_PRIVATE_JWK`. If the owner kept no copy, a new key is the way: put the new key on the server,
  and publish both public keys for a day by having DoeDesk Connect accept both. Connect is not
  deployed today, so nothing verifies these tokens yet and a new key breaks nothing.

Everything else on the list is in the password manager or is made new at the switch.

## The Worker's settings during the move

Set with `npx wrangler secret put NAME` or in the Worker's `vars`. All are unset in normal running.

| Setting | When | What it does |
| --- | --- | --- |
| `MAINTENANCE=freeze` | The final copy | Nothing is written to D1 |
| `FORWARD_API_TO`, `FORWARD_SECRET` | From the copy until the address moves | API requests are passed to the server |
| `MAIL_RELAY_URL`, `MAIL_RELAY_KEY` | From the copy onwards, for good | Contact mail is forwarded as before and its copy is stored by the server |
| `CONFIRM_REDIRECT_TO=https://api.doedesk.com` | Once the address has moved, for good | Sign-in links that open on the site are sent to the API |
