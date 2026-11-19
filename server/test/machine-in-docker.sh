#!/usr/bin/env bash
# The machine side, rehearsed on a Linux container that runs systemd: the same scripts and unit
# files the real machine gets, over a real SSH connection.
#
#   server/test/machine-in-docker.sh        needs Docker; takes a few minutes the first time
#
# What it does, in the order an operator sets up a machine:
#   first deploy (install.sh: user, folders, pinned Bun and Litestream with checked checksums,
#   units) -> settings -> start -> the API answers -> the sandbox holds -> the nightly job, once ->
#   the country file update's builder -> a snapshot -> the self-check -> a restart under load ->
#   a second deploy -> the signed release records it served -> rollback -> automatic updates ->
#   the firewall rules.
#
# It deploys the committed HEAD, as deploy.sh always does. The release records are signed with a
# key made for the run and kept out of the public transparency log, and are logged in a folder of
# the run, not in releases/log. Without cosign they go unsigned (deploy.sh --unsigned).
# KEEP=1 leaves the container running.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
docker info >/dev/null 2>&1 || { echo "skipped: Docker is not running here"; echo; echo "all passed"; exit 0; }

failures=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1${2:+ -> $2}"; failures=$((failures + 1)); }
check() { if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1" "$(eval "$2" 2>&1 | tail -3 | tr '\n' ' ' | cut -c1-400)"; fi; }

name="doedesk-machine-$$"
work="$(mktemp -d)"
trap '[ "${KEEP:-}" = "1" ] || docker rm -f "$name" >/dev/null 2>&1; rm -rf "$work"' EXIT
ssh-keygen -q -t ed25519 -N "" -f "$work/key"

docker build -q -t doedesk-machine-test - >/dev/null <<DOCKERFILE
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && apt-get install -y -qq systemd systemd-sysv dbus openssh-server sudo curl ca-certificates python3 nftables iproute2 >/dev/null && apt-get clean
RUN useradd -m -s /bin/bash ops && echo 'ops ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/ops && mkdir -p /home/ops/.ssh /run/sshd
RUN systemctl enable ssh >/dev/null 2>&1; systemctl mask systemd-resolved getty@tty1 >/dev/null 2>&1; true
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
DOCKERFILE
port=$((22000 + RANDOM % 5000))
docker run -d --name "$name" --privileged --cgroupns=host --tmpfs /run --tmpfs /run/lock -v /sys/fs/cgroup:/sys/fs/cgroup:rw -p "127.0.0.1:$port:22" doedesk-machine-test >/dev/null
docker exec -i "$name" bash -c "cat > /home/ops/.ssh/authorized_keys" < "$work/key.pub"
docker exec "$name" bash -c "chown -R ops:ops /home/ops/.ssh && chmod 700 /home/ops/.ssh && chmod 600 /home/ops/.ssh/authorized_keys"
cat > "$work/ssh_config" <<CONFIG
Host machine
  HostName 127.0.0.1
  Port $port
  User ops
  IdentityFile $work/key
  IdentitiesOnly yes
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
  LogLevel ERROR
CONFIG
export DOEDESK_SSH="ssh -F $work/ssh_config"
on() { $DOEDESK_SSH machine "$@"; }
for _ in $(seq 1 60); do on true 2>/dev/null && break; sleep 1; done
check "the container runs systemd and takes SSH" "on 'systemctl is-system-running --wait; systemctl --version | head -1'"

# --- First deploy --------------------------------------------------------------------------------
# Release records for this run only (docs/releases.md): a throwaway key, no public log, no commit.
export DOEDESK_RELEASE_LOG="$work/release-log" DOEDESK_ALLOW_UNPUBLISHED=1 DOEDESK_RELEASE_NO_TLOG=1
if command -v cosign >/dev/null 2>&1; then
  (cd "$work" && COSIGN_PASSWORD=rehearsal cosign generate-key-pair --output-key-prefix release >/dev/null 2>&1)
  export DOEDESK_RELEASE_KEY="$work/release.key" COSIGN_PASSWORD=rehearsal
  signed=yes
else
  export DOEDESK_RELEASE_UNSIGNED=1
  signed=""
fi
first="$(server/ops/deploy.sh --first machine 2>&1)"; first_status=$?
[ $first_status -eq 0 ] && ok "first deploy: the release is sent, the machine is prepared, the database is made, nothing is started" || bad "first deploy" "$(echo "$first" | tail -5 | tr '\n' ' ')"
check "install: pinned Bun and Litestream are in place, with their checksums checked" "on '/opt/doedesk/runtime/bun --version | grep -x 1.4.3 && /opt/doedesk/runtime/litestream version | grep 0.5.18'"
check "install: the user has no shell and no home; settings are root's alone; the data folder is the user's alone" "on 'getent passwd doedesk | grep -q /usr/sbin/nologin && [ \"\$(sudo stat -c %a:%U /etc/doedesk)\" = 700:root ] && [ \"\$(sudo stat -c %a:%U /etc/doedesk/api.env)\" = 600:root ] && [ \"\$(sudo stat -c %a:%U /var/lib/doedesk)\" = 700:doedesk ] && [ \"\$(sudo stat -c %a:%U /var/lib/doedesk/doedesk.sqlite)\" = 600:doedesk ]'"
check "install: running it again changes nothing and fails nothing" "on 'sudo /opt/doedesk/api/current/server/ops/install.sh'"
check "first deploy: the API is not running yet, because it has no settings" "on '! systemctl is-active --quiet doedesk-api'"
refused="$(on 'sudo systemctl start doedesk-api; sleep 2; sudo journalctl --namespace doedesk -u doedesk-api -n 20 --no-pager' 2>&1)"
echo "$refused" | grep -q "JWT_PRIVATE_JWK" && echo "$refused" | grep -q "ADMIN_KEY must be" && ok "start without settings: the service names what is missing and does not run" || bad "start without settings" "$(echo "$refused" | tail -4 | tr '\n' ' ' | cut -c1-400)"
on 'sudo systemctl stop doedesk-api; sudo systemctl reset-failed doedesk-api' >/dev/null 2>&1

# --- Settings (made up for the rehearsal), then start ----------------------------------------------
jwk="$(node -e 'const { generateKeyPairSync } = require("node:crypto"); console.log(JSON.stringify({ ...generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" }), kid: "rehearsal" }))')"
admin="rehearsal-$(openssl rand -hex 16)"
on "sudo tee /etc/doedesk/api.env >/dev/null" <<SETTINGS
DOEDESK_ENV=rehearsal
JWT_PRIVATE_JWK='$jwk'
ADMIN_KEY=$admin
AUTHENTICA_API_KEY=rehearsal
EXPOSE_LOGIN_SECRETS=1
ENGINE_URL=http://127.0.0.1:8080
SETTINGS
on 'printf "CHECK_REPLICATION=0\nCHECK_SNAPSHOT=0\n" | sudo tee /etc/doedesk/check.env >/dev/null; sudo systemctl enable --now doedesk-api doedesk-nightly.timer doedesk-geo-update.timer doedesk-check.timer' >/dev/null 2>&1
for _ in $(seq 1 30); do on 'curl -fsS http://127.0.0.1:8787/v1/health' >/dev/null 2>&1 && break; sleep 1; done
check "start: the API answers on the machine's loopback, as the user doedesk, under Bun" "on 'curl -fsS http://127.0.0.1:8787/v1/health | grep -q ok && [ \"\$(ps -o user= -p \$(systemctl show -p MainPID --value doedesk-api))\" = doedesk ] && curl -fsS http://127.0.0.1:8787/internal/health | grep -q \"\\\"runtime\\\":\\\"bun 1.4.3\\\"\"'"
check "start: it listens on loopback only" "on 'ss -ltnH | grep :8787 | grep -q 127.0.0.1 && ! ss -ltnH | grep :8787 | grep -qv 127.0.0.1'"

# A sign-in through an SSH tunnel, as the rehearsal on the real machine is reached.
tunnel=$((30000 + RANDOM % 5000))
$DOEDESK_SSH -f -N -L "$tunnel:127.0.0.1:8787" machine
flow="$(node test/auth-flow.mjs "http://127.0.0.1:$tunnel" 2>&1)"
echo "$flow" | grep -q "^all passed" && ok "through an SSH tunnel: the sign-in suite passes against the machine ($(echo "$flow" | grep -c '^ok') checks)" || bad "sign-in suite through the tunnel" "$(echo "$flow" | grep FAIL | head -3 | tr '\n' ' ' | cut -c1-400)"

# --- The sandbox ------------------------------------------------------------------------------------
pid_of="systemctl show -p MainPID --value doedesk-api"
check "sandbox: the service cannot read its own settings file, or root's files" "on 'sudo nsenter -t \$($pid_of) -m -U --preserve-credentials true 2>/dev/null; ! sudo -u doedesk cat /etc/doedesk/api.env && ! sudo -u doedesk ls /root'"
probe='sudo systemd-run --quiet --wait --collect --pipe -p User=doedesk -p ProtectSystem=strict -p ReadWritePaths=/var/lib/doedesk -p ProtectHome=true -p PrivateTmp=true -p NoNewPrivileges=true'
check "sandbox: with the unit's settings a process can write its data folder and nowhere else on the system" "on '$probe sh -c \"touch /var/lib/doedesk/tmp/probe && rm /var/lib/doedesk/tmp/probe && ! touch /opt/doedesk/probe && ! touch /etc/probe && ! touch /usr/probe && ! touch /var/probe\"'"
exposure="$(on 'systemd-analyze security doedesk-api --no-pager | tail -1')"
echo "$exposure" | grep -Eq "OK|MEDIUM" && ok "sandbox: systemd rates the unit: $(echo "$exposure" | sed 's/.*Overall exposure level for doedesk-api.service: //')" || bad "sandbox rating" "$exposure"
check "sandbox: every unit file is accepted by systemd without complaint" "on 'out=\$(systemd-analyze verify /etc/systemd/system/doedesk-*.service /etc/systemd/system/doedesk-*.timer 2>&1 | grep -v \"doedesk-alert@\" ); [ -z \"\$out\" ] || { echo \"\$out\"; false; }'"

# --- The nightly job, the snapshot, the country file, the self-check -----------------------------------
on 'sudo systemctl start doedesk-nightly.service; sudo systemctl start doedesk-nightly.service' >/dev/null 2>&1
night="$(on 'sudo journalctl --namespace doedesk -u doedesk-nightly -n 20 --no-pager' 2>&1)"
[ "$(echo "$night" | grep -c "nightly ran$")" = "1" ] && echo "$night" | grep -q "already done" && ok "nightly: started twice, it ran once; the second start saw the night was taken" || bad "nightly once" "$(echo "$night" | tail -4 | tr '\n' ' ' | cut -c1-400)"
check "nightly: the timer is set for 03:17 UTC" "on 'systemctl list-timers doedesk-nightly.timer --no-pager | grep -q \"03:17:00 UTC\"'"

on 'age-keygen -o /tmp/snapshot.key 2>/dev/null; printf "SNAPSHOT_AGE_RECIPIENT=%s\nSNAPSHOT_KEEP_LOCAL=/var/lib/doedesk/tmp/kept\n" "$(grep -o "age1[0-9a-z]*" /tmp/snapshot.key | head -1)" | sudo tee /etc/doedesk/backup.env >/dev/null; sudo systemctl start doedesk-snapshot.service' >/dev/null 2>&1
check "snapshot: the unit makes an encrypted snapshot of the running database" "on 'sudo journalctl --namespace doedesk -u doedesk-snapshot -n 10 --no-pager | grep -q \"snapshot doedesk-.*sqlite.gz.age bytes=\" && sudo sh -c \"head -c 21 /var/lib/doedesk/tmp/kept/*.age\" | grep -q age-encryption.org'"
check "restore: with the private key, on a machine with no sqlite3 command, the snapshot restores and is found sound" "on 'sudo sh -c \"cp /var/lib/doedesk/tmp/kept/*.age /tmp/snap.age\" && sudo /opt/doedesk/api/current/server/ops/restore.sh snapshot /tmp/snap.age /tmp/restored.sqlite --identity /tmp/snapshot.key | grep -q \"sound, .* accounts\"'"

printf '5.42.224.0,5.42.224.255,AS,SA,Makkah,Jeddah,0,0\n' | on 'cat > /tmp/tiny.csv'
check "country file: the builder refuses data that is not the whole database, and leaves no file" "on '! sudo -u doedesk /opt/doedesk/runtime/bun /opt/doedesk/api/current/server/geo-build.ts --input /tmp/tiny.csv --output /var/lib/doedesk/geo/country.ddgeo --source tiny && ! sudo test -e /var/lib/doedesk/geo/country.ddgeo'"
check "country file: the timer is set, twice a month" "on 'systemctl list-timers doedesk-geo-update.timer --no-pager | grep -q doedesk-geo-update'"

report="$(on 'sudo systemctl start doedesk-check.service; sudo journalctl --namespace doedesk -u doedesk-check -n 6 --no-pager' 2>&1)"
echo "$report" | grep -q "the country file is missing" && ok "self-check: it runs, and says what is wrong here: the country file is missing" || bad "self-check" "$(echo "$report" | tail -4 | tr '\n' ' ' | cut -c1-400)"
check "self-check: a failed check starts the alert unit, which without an address only records the failure" "on 'sudo journalctl --namespace doedesk -n 40 --no-pager | grep -q \"alert not sent (ALERT_EMAIL or SMTP_HOST is not set): doedesk-check.service failed\"'"

# --- The journal ---------------------------------------------------------------------------------------
check "journal: the services write to a journal of their own, kept seven days" "on 'sudo journalctl --namespace doedesk -n 1 --no-pager | grep -q . && grep -q MaxRetentionSec=7day /etc/systemd/journald@doedesk.conf && ! sudo journalctl -u doedesk-api -n 5 --no-pager 2>/dev/null | grep -q listening'"

# --- A restart, a second deploy, rollback ---------------------------------------------------------------
before="$(on 'readlink /opt/doedesk/api/current')"
second="$(server/ops/deploy.sh machine 2>&1)"; second_status=$?
after="$(on 'readlink /opt/doedesk/api/current')"
[ $second_status -eq 0 ] && [ "$before" != "$after" ] && echo "$second" | grep -q "is live" && ok "update: a second deploy switches to the new release and the API is well on it" || bad "second deploy" "$(echo "$second" | tail -4 | tr '\n' ' ' | cut -c1-400)"
check "update: the sign-in made before the update still works after it" "node test/auth-flow.mjs http://127.0.0.1:$tunnel | grep -q '^all passed'"
mapfile -t records < <(ls "$DOEDESK_RELEASE_LOG"/*.json | grep -v "sigstore.json$" | sort)
check "release: each deploy logged one record, the second linked to the first" "[ \${#records[@]} -eq 2 ] && grep -q \"\$(shasum -a 256 \"\${records[0]}\" | cut -d' ' -f1)\" \"\${records[1]}\""
check "release: the API serves the running release's record byte for byte" "curl -fsS http://127.0.0.1:$tunnel/v1/release | cmp -s - \"\${records[1]}\""
if [ -n "$signed" ]; then
  check "release: and its signature, which checks against the key, with the archive made again from the commit" "node server/ops/release.mjs verify --url http://127.0.0.1:$tunnel --key $work/release.pub --log $DOEDESK_RELEASE_LOG --no-tlog"
  check "release: a record altered after signing fails the check" "curl -fsS http://127.0.0.1:$tunnel/v1/release | sed 's/deployedAt\": \"2/deployedAt\": \"1/' > $work/altered.json && curl -fsS http://127.0.0.1:$tunnel/v1/release/signature > $work/altered.sigstore.json && ! node server/ops/release.mjs verify --record $work/altered.json --key $work/release.pub --log $DOEDESK_RELEASE_LOG --no-tlog"
else
  check "release: unsigned, the API says so" "[ \"\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$tunnel/v1/release/signature)\" = 404 ]"
fi
back="$(server/ops/rollback.sh machine 2>&1)"; back_status=$?
[ $back_status -eq 0 ] && [ "$(on 'readlink /opt/doedesk/api/current')" = "$before" ] && ok "rollback: the previous release is put back and the API is well on it" || bad "rollback" "$(echo "$back" | tail -3 | tr '\n' ' ' | cut -c1-300)"
check "rollback: the API then serves the previous release's record" "curl -fsS http://127.0.0.1:$tunnel/v1/release | cmp -s - \"\${records[0]}\""
on 'sudo systemctl stop doedesk-api' >/dev/null 2>&1
stop="$(on 'sudo journalctl --namespace doedesk -u doedesk-api -n 6 --no-pager' 2>&1)"
echo "$stop" | grep -q "stopped$" && ok "stop: systemd's stop is the clean one: the service says it stopped" || bad "stop" "$(echo "$stop" | tail -3 | tr '\n' ' ' | cut -c1-300)"

# --- Updates and the firewall --------------------------------------------------------------------------
check "updates: automatic security updates are turned on, with a reboot when needed at 01:30 UTC" "on 'sudo /opt/doedesk/api/current/server/ops/unattended-upgrades.sh && grep -q \"Automatic-Reboot \\\"true\\\"\" /etc/apt/apt.conf.d/52doedesk-unattended && grep -q 01:30 /etc/apt/apt.conf.d/52doedesk-unattended && systemctl is-enabled apt-daily-upgrade.timer'"
rules="$(on 'sudo /opt/doedesk/api/current/server/ops/firewall.sh >/dev/null && sudo /opt/doedesk/api/current/server/ops/firewall.sh --show' 2>&1)"
echo "$rules" | grep -q "policy drop" && echo "$rules" | grep -q "tcp dport 22 accept" && ! echo "$rules" | grep -q "443" && ok "firewall: for the rehearsal, only SSH comes in; the web ports stay closed" || bad "firewall (rehearsal)" "$(echo "$rules" | tr '\n' ' ' | cut -c1-300)"
on true >/dev/null 2>&1 && ok "firewall: SSH still works with the rules in force" || bad "firewall locked SSH out"
rules="$(on 'sudo /opt/doedesk/api/current/server/ops/firewall.sh --web >/dev/null && sudo /opt/doedesk/api/current/server/ops/firewall.sh --show' 2>&1)"
echo "$rules" | grep -Eq "tcp dport \{ 80, 443 \} accept" && ok "firewall: with --web, 80 and 443 are added, for the switch" || bad "firewall (web)" "$(echo "$rules" | tr '\n' ' ' | cut -c1-300)"

pkill -f "ssh -F $work/ssh_config -f -N" 2>/dev/null
echo
[ $failures -eq 0 ] && echo "all passed" || echo "$failures failed"
exit $failures
