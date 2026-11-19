# Release records

Every time code is put on the production machine, a record of it is made, signed, added to a public
log, and served by the machine itself. This page says what a record holds, how it is made, how
anyone checks it, and what it does and does not prove.

## What a record holds

```json
{
  "schema": "doedesk-release/1",
  "service": "api.doedesk.com",
  "repository": "https://github.com/accelerate-sa/doedesk-server",
  "sequence": 7,
  "release": "20261120T101500Z-0123456789ab",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "archive": {
    "sha256": "…64 hex characters…",
    "bytes": 1105920,
    "made": "git archive --format=tar 0123…4567 -- server src migrations docs package.json"
  },
  "deployedAt": "2026-11-20T10:15:00Z",
  "previous": { "name": "00006-20261118T090000Z-fedcba987654.json", "sha256": "…" }
}
```

- `commit` is a commit of this repository. `archive` is the exact file that was sent to the
  machine: `git archive` of that commit, limited to what the server runs. `git archive` makes the
  same bytes for the same commit on any computer (the settings that could differ are pinned in
  [`server/ops/release.mjs`](../server/ops/release.mjs)), so anyone can make it again and compare.
- `previous` is the sha256 of the record before it in the log. Taking a record out of the log, or
  changing one, breaks the link of the next.
- Nothing in a record is secret, and nothing in it names a person.

## Where records are

| Where | What |
| --- | --- |
| [`releases/log/`](../releases/log) in this repository | Every record, `NNNNN-<time>-<commit>.json`, with its signature beside it as `….sigstore.json` |
| `GET https://api.doedesk.com/v1/release` | The record of the release the API is running now, byte for byte as signed |
| `GET https://api.doedesk.com/v1/release/signature` | Its signature (a Sigstore bundle), or 404 `not_signed` |
| The Sigstore public transparency log (Rekor) | An entry for every signature, timestamped by Sigstore, which DoeDesk cannot remove or backdate |
| [`releases/cosign.pub`](../releases/cosign.pub) | The public key the records are signed with |

The log lists every release **sent** to production. A release that failed its health check was
replaced by the one before it within a minute; its record stays in the log, and `GET /v1/release`
says which release runs.

## Checking

You need git, Node 22 or newer, and [cosign](https://docs.sigstore.dev/cosign/system_config/installation/)
2.4 or newer.

```sh
git clone https://github.com/accelerate-sa/doedesk-server && cd doedesk-server

# The release the production API runs now:
node server/ops/release.mjs verify

# Every release ever sent, and the chain between them:
node server/ops/release.mjs verify-log
```

`verify` fetches the record and its signature from `https://api.doedesk.com/v1/release` and checks:

1. the signature is good for those exact bytes, by the key in `releases/cosign.pub`, and the
   signature is in the public transparency log (it prints the time the log took it);
2. the commit is in this repository, and the archive made from it here has the sha256 and size in
   the record;
3. the record is in `releases/log/`, byte for byte, and its link to the record before it holds.

Each line says `ok` or `FAIL`; the exit status is 0 only when all hold. `--record <file>` checks a
record from a file instead, `--url <origin>` asks another server.

By hand, without the script:

```sh
curl -s https://api.doedesk.com/v1/release -o record.json
curl -s https://api.doedesk.com/v1/release/signature -o record.sigstore.json
cosign verify-blob --key releases/cosign.pub --bundle record.sigstore.json record.json
commit=$(node -p 'require("./record.json").commit')
git -c tar.umask=0002 -c core.autocrlf=false -c core.eol=lf -c core.attributesFile=/dev/null \
  archive --format=tar "$commit" -- server src migrations docs package.json | shasum -a 256
node -p 'require("./record.json").archive.sha256'      # the same
```

Then read the code at that commit. Where text and files are handled, and what is stored, is in the
[README](../README.md#what-it-stores-and-what-it-never-stores).

## What this proves, and what it does not

It proves that the operator of DoeDesk Cloud **stated**, under a key only the operator holds and
at a time a third party recorded, that a given public commit was put on the production machine,
and that the record served by the machine is that statement. A change that is not in this
repository can only reach the machine with a record that names a commit that does not make that
code (which anyone can see), or without a record (which the machine then serves, or fails to
serve, in plain view), or with the signing key and the server both in someone else's hands.

It does **not** prove, by itself, that the machine runs what its record says: the operator, or
someone who controls the machine, could serve a true old record while running something else.
Closing that gap needs the hardware to vouch for the code it runs (remote attestation). On the
machines DoeDesk uses today the hardware can vouch only for the cloud provider's firmware, not for
our code.
When attestation is in place, the measured code will be checked against these same records.

## How a record is made (for the operator)

`server/ops/deploy.sh` makes it on every deploy; nothing is done by hand.

1. It makes the archive from a commit of this repository and takes its sha256. (Run from the
   operator's private repository, it first checks that the private revision has the same `server/`,
   `src/` and `migrations/` as the public commit, file for file, and stops if not.)
2. It refuses a commit that is on no remote branch (`--allow-unpublished` overrides it), because no
   one else could check the record.
3. It makes the record and signs it with `cosign sign-blob`, which also puts the signature in the
   transparency log.
4. It adds the record and its signature to `releases/log/` and commits them (it does not push:
   push after the deploy).
5. It sends the archive; the machine checks the sha256 before unpacking it, and keeps the record
   and the signature beside the release, where the API reads them on each request.

### The signing key

One cosign key pair, made once, on the operator's computer:

```sh
mkdir -p ~/.config/doedesk && cd ~/.config/doedesk
cosign generate-key-pair --output-key-prefix release-cosign   # asks for a password
```

- `release-cosign.key` is the private key, encrypted with that password. It stays on the
  operator's computer (`DOEDESK_RELEASE_KEY` names another place) and a copy goes in the password
  manager with the password. It is never on the server and never in a repository.
- `release-cosign.pub` is committed to this repository as `releases/cosign.pub`.
- `COSIGN_PASSWORD` in the environment saves typing the password at each deploy.

Why a key and not Sigstore's "keyless" signing: keyless signing puts the signer's email address in
a public certificate for every signature, and needs a browser sign-in at each deploy. A key gives
the same public transparency log entry without either. Why cosign and not a plain signature tool
such as minisign: the transparency log. With a plain signature the operator could sign a record
later and date it earlier; with cosign the log's own timestamp says when the signature was made.

If the key is lost or exposed: make a new pair, commit the new public key with a line in
`releases/KEYS.md` saying from which sequence number it applies and why, and keep the old public key
there (`releases/cosign-<n>.pub`) so that old records still check.

### After an unsigned deploy

`deploy.sh --unsigned` exists for an emergency (cosign or the transparency log unreachable, the key
not at hand). It prints a warning in red before and after. The record is made, logged and served
as usual, without a signature, and `verify` reports `FAIL the record is signed`. As soon as
possible:

```sh
node server/ops/release.mjs sign --record releases/log/<the record>.json --key ~/.config/doedesk/release-cosign.key
git add releases/log && git commit -m "Signature for release record <n>, signed after an emergency deploy" && git push
ssh HOST "sudo tee /opt/doedesk/api/current/RELEASE.sigstore.json >/dev/null" < releases/log/<the record>.sigstore.json
```

The transparency log then shows when the signature was made, later than `deployedAt`; that is the
honest account of what happened.

### Keeping the public repository current

The operator works in a private repository that also holds the website and internal documents. The
server code there must be the same as here. After changing `server/`, `src/`, `migrations/` or
`test/` in the private repository:

```sh
for folder in server src migrations test; do rsync -a --delete ../doedesk-cloud/$folder/ $folder/; done
git diff                                              # read it: nothing private goes public
git commit -am "…" && git push
```

`deploy.sh` stops when `server/`, `src/` or `migrations/` differ, so a release is never made from
code that was not published. Dependencies and `package.json` are kept by hand: this one has no
scripts for the website.
