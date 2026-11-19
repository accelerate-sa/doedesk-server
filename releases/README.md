# Release records

`log/` holds one signed record for every release sent to the production DoeDesk Cloud API, in
order, and `cosign.pub` is the key they are signed with. [`docs/releases.md`](../docs/releases.md)
says what a record proves and how to check one:

```sh
node server/ops/release.mjs verify       # the release running now
node server/ops/release.mjs verify-log   # every release, and the chain between them
```

Records are added by `server/ops/deploy.sh`. Do not edit or remove one: the next record holds the
sha256 of the one before it.
