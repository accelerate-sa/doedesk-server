#!/usr/bin/env bash
# Looks at the service from outside, as the apps reach it. Run it from any other machine: by hand,
# from cron, or from a monitoring service that can run a script. Exit 0 when all is well.
#
#   check-outside.sh                       checks https://api.doedesk.com
#   check-outside.sh https://other.host    checks another address (the rehearsal, through a tunnel)
#
# What it proves, without a sign-in and without touching any account:
#   /v1/health               the process answers
#   /v1/me with no sign-in   401 "unauthenticated" as JSON: the route table is the service's
#   /v1/me with a made-up token   401 from a database lookup: the database answers
#   /v1/auth/options         the country of this request is known (the country file works)
#   the certificate          more than 14 days left (HTTPS addresses only)
set -uo pipefail

base="${1:-https://api.doedesk.com}"
base="${base%/}"
problems=()
get() { curl --silent --max-time 15 --output /dev/null --write-out '%{http_code}' "$@"; }
body() { curl --silent --max-time 15 "$@"; }

[ "$(get "$base/v1/health")" = "200" ] || problems+=("$base/v1/health does not answer 200")
[ "$(get "$base/v1/me")" = "401" ] || problems+=("/v1/me without a sign-in is not 401")
lookup="$(body --header 'authorization: Bearer dd_check_not_a_real_token' "$base/v1/me")"
case "$lookup" in *'"unauthenticated"'*) ;; *) problems+=("a sign-in lookup did not come back from the database as expected") ;; esac
options="$(body "$base/v1/auth/options")"
case "$options" in
  *'"country":null'*) problems+=("the service does not know this request's country (country file missing, stale, or this address is in no range)") ;;
  *'"country":"'*) ;;
  *) problems+=("/v1/auth/options did not answer as expected") ;;
esac
case "$base" in
  https://*)
    host="${base#https://}"; host="${host%%/*}"
    end="$(echo | openssl s_client -servername "$host" -connect "$host:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
    if [ -z "$end" ]; then problems+=("no certificate could be read from $host")
    else
      left=$(( ( $(date -u -d "$end" +%s 2>/dev/null || date -u -j -f '%b %e %T %Y %Z' "$end" +%s) - $(date -u +%s) ) / 86400 ))
      [ "$left" -gt 14 ] || problems+=("the certificate of $host has $left days left: automatic renewal is not working")
    fi ;;
esac

if [ ${#problems[@]} -eq 0 ]; then echo "ok $base"; exit 0; fi
printf 'PROBLEM %s\n' "${problems[@]}"
exit 1
