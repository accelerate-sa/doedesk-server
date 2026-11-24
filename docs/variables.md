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
| `DOEDESK_SOURCE_URL` | Optional. Where the source of the running service is, told at `GET /v1/source` with the licence and the commit. The published repository unless set. Someone who runs a changed copy of this server sets it to where their changed source is (the licence, section 13) | Typed |
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

### A layer beside the service (optional)

The service looks for a folder named `enterprise` beside `server/` and `src/` when it starts, and
attaches it through `src/extension.ts` if it is there. With no such folder nothing below applies.

| Name | What it is | Where it comes from |
| --- | --- | --- |
| `DOEDESK_EXTENSION` | `off` starts the service without the layer although its folder is there | Typed |
| `DOEDESK_EXTENSION_DIR` | Another name for the folder | Typed |
| `EXT_…` | Any setting whose name starts with `EXT_` is handed to the layer as it is. The service reads none of them | The layer's own documentation |

### The worker (optional, one upstream per account region)

The worker is the model that reads sealed documents for the app
(`POST /v1/worker/chat/completions`). It is the one part of the service that sends what people send
to a server off this machine. Each account has a region (`sa`, `eu` or `global`; the person
chooses it, and a new account starts with a guess from where it was made), and a request goes to
the upstream for that region and to no other:

| Region | Upstream unless set | Model unless set | Asked for | Served by |
| --- | --- | --- | --- | --- |
| `sa` | deep.sa, `https://alapi.deep.sa/v1`. In Saudi Arabia according to deep.sa; the city and the operator of the hardware are not confirmed | `qwen/qwen3.8-27b` | A JSON object, reasoning `none` | deep.sa |
| `eu` | None. A hosted worker is not offered in this region yet | None | | Nobody. An account in this region seals with a worker of its own |
| `global` | OpenRouter, `https://openrouter.ai/api/v1` | `thinkingmachines/inkling-2-mini` | The strict schema, reasoning `none` | Any host of OpenRouter's that keeps nothing (PrimeIntellect today) |

These are the settings the evaluation measured (Round 5, 24 November 2026: `REPORT.md` in the
evaluation's `results/round5`), and they are the defaults, so `sa` and `global` need only their keys:

- **`sa`.** deep.sa refuses one strict-schema request in five (`json_validate_failed`). Asked for
  a JSON object it refused none of 259 and scored 1,496 of 1,496 fields.
- **`eu`.** No default. The two measured models are served by no host where this region
  requires, so the region has no address and no model of its own: its accounts are answered 503
  `worker_unavailable` ("not available in your region yet"), the app says so, and no other region
  answers for them. A key alone changes nothing, and the server refuses to start with
  `WORKER_EU_API_KEY` set and `WORKER_EU_URL` or `WORKER_EU_MODEL` missing. When a host in the EU
  serves one of the two models, the region is given an upstream by setting all three, with
  `WORKER_EU_PROVIDER`, `WORKER_EU_EXPECTED_PROVIDER` and `WORKER_EU_EXPECTED_DATA_REGION` to hold
  it there, after the evaluation has measured it.

**The worker is an open-weight model, in every region.** A worker is a model whose weights the
customer, or DoeDesk, can run on hardware under their own control: their own server, a dedicated
node, a rented GPU in their region. Sealing exists so that a file does not go to an AI company's
model, and a closed model can be run nowhere but at its maker's. Only the two models the
evaluation measured can be set: **Qwen3.8 27B** and **Inkling 2 mini**, however a host writes the
name (`OPEN_WEIGHT_WORKER_MODELS` in `src/worker-regions.ts`). The server refuses to start with any
other in `WORKER_<R>_MODEL`, and a region set to one has no worker. Adding a model means measuring
it first and adding it to that list.

A key does not open the worker to anyone by itself. The service keeps no list of who has the
worker: `WORKER_OPEN=1` gives it to every signed-in account, and without that setting no account
has it unless a layer beside the service says so (`docs/runbook.md`, "Who has the hosted worker").
An account without it is answered 403 `worker_not_included` before its request is read, with or
without a key.

There is no fallback. A region without a key answers 503 `worker_unavailable` to its accounts, a
region whose upstream fails answers 502, and a region that is busy answers 429 `worker_busy`; none
is sent to another region. This server receives
the sealed text on its way to the upstream and back. Nothing sent or answered is stored or logged
here; only counts are. The machine's outbound rules must let the API reach each upstream that has
a key.

Requests wait their turn in a queue per region, in this server's memory (`src/worker-queue.ts`).
An upstream account takes only so many requests at once and so many a minute, for all our
accounts together, refuses the rest at once, and counts the refused ones against the minute. So
no more are in flight than `PARALLEL` and no more are sent in a clock minute than `PER_MINUTE`;
accounts take turns, so one person's folder does not hold up another's question; when the
upstream names a time to wait, nothing is sent until then; and a request not sent within
`MAX_WAIT_SECONDS` is answered as busy with how many are waiting. `GET /v1/me` tells the app the
region's `parallel`, the wait, and how many requests are in flight and waiting.

The `sa` region is served only while deep.sa's own list of models (`GET <URL>/models`) marks the
configured model `hosted_in: saudi`: the same key reaches models deep.sa hosts elsewhere. The list
is read when the server starts and again every ten minutes while requests come; a list that
cannot be read does not stop a region confirmed within the hour. This is deep.sa's statement
read by this server, not a measurement of where the hardware is.

Each setting below exists once per region: replace `<R>` with `SA`, `EU` or `GLOBAL`.

| Setting | What it is | Where the value comes from |
| --- | --- | --- |
| `WORKER_<R>_API_KEY` | Sent to that region's upstream as a bearer token. Unset, the region has no worker | The password manager. Never in the repository |
| `WORKER_<R>_URL` | The upstream's base address; requests go to `<URL>/chat/completions`. The table above unless set; `eu` has none | Typed |
| `WORKER_<R>_MODEL` | The one model every request in the region is sent to, whatever the caller names. The table above unless set; `eu` has none. It must be one of the two open-weight models named above. Changing it needs no app release: the app is told the model with the account | Typed |
| `WORKER_<R>_STRUCTURED` | How the app should ask this model for JSON: `jsonSchema`, `jsonObject` or `none`. Told to the app with the account. Unless set: `jsonObject` for `sa` and `eu`, `jsonSchema` for `global` (the notes above say why). The app checks every answer itself, whichever it is | From testing the model |
| `WORKER_<R>_PARALLEL` | Requests in flight at once, for all accounts together. `1` for `sa` unless set (deep.sa's smallest plan; `5` on the next), `16` for the other two | The upstream account's plan |
| `WORKER_<R>_PER_MINUTE` | Requests sent in a clock minute, answered or not. `55` for `sa` unless set (the smallest plan allows 60; `280` suits the next), `0` (no limit) for the other two | The plan, a little under it |
| `WORKER_<R>_MAX_WAIT_SECONDS` | How long a request waits for its turn before it is answered as busy. `20` unless set, `25` at most: with the two minutes an upstream may take it must stay under the 150 seconds Caddy waits | Typed |
| `WORKER_<R>_MAX_WAITING` | Requests that may wait at once. `200` unless set; one more is answered as busy at once | Typed |
| `WORKER_<R>_HOSTED_IN` | What the upstream's model list must say of the model in `hosted_in`. `saudi` for `sa` unless set, nothing for the other two. `any`: not checked | Typed |
| `WORKER_<R>_REASONING_EFFORT` | Sent as `reasoning_effort` in place of the caller's. `none` for all three regions unless set, which is what each model was measured with. `caller` passes the caller's on. Some hosts refuse `none`: give those `low` | From testing the model |
| `WORKER_<R>_MIN_OUTPUT_TOKENS` | The caller's output limit is raised to this when it is lower. `4000` unless set: deep.sa answered structured requests at 4000 and failed them at 300 | From testing the model |
| `WORKER_<R>_PROVIDER` | A JSON object sent as `provider`, which is how OpenRouter is told which hosts may serve a request and what they may keep. Unset: for `global`, `{"data_collection":"deny","zdr":true}` (only hosts that neither train on nor keep what they are sent); nothing for `sa` and `eu`. To hold a region to one host, add `"order":["<host>"],"allow_fallbacks":false`, so that host serves it or none does. `none` sends nothing | Typed |
| `WORKER_<R>_EXPECTED_PROVIDER` | The name the upstream's answer gives in `provider` when the right host served it. Nothing unless set. An answer that names another is still passed on, and counted as off region on the dashboard. `any`: not checked | From a real answer |
| `WORKER_<R>_EXPECTED_DATA_REGION` | What OpenRouter's own record of a call (`GET <URL>/generation?id=`) must say in `data_region`. Nothing unless set. The answer itself names the host and not the place, so the record of one answer a minute is read after the answer has gone; one that names another data region, or another provider than the one expected, is counted as off region and logged (`worker_off_region eu`). A record that cannot be read is logged (`worker_record_unread`) and not counted. It is OpenRouter's statement, not a measurement. `any`: not checked | From a real record |
| `WORKER_OPEN` | Optional. `1`: every signed-in account has the worker. Unset: no account has it unless a layer beside the service gives it one (`src/extension.ts`). DoeDesk Cloud leaves it unset: there the worker is offered under an agreement | Typed |
| `WORKER_PRICE_PER_1M_INPUT_TOKENS` | Optional. What the worker costs, in US dollars, per million tokens sent to it. One figure for all three regions: the counts are not kept per region. For the owner's dashboard only | The providers' price lists |
| `WORKER_PRICE_PER_1M_OUTPUT_TOKENS` | Optional. The same per million tokens it answers with | As above |

With no price set, for the engine or the worker, the dashboard shows no cost anywhere (the accounts
table and its CSV have no cost column, and the account and spread pages no cost tiles). With some
set, the others count as free.

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
