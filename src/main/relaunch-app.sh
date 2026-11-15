#!/bin/bash
set -eu
parent_pid="$1"
application="$2"
case "$application" in /*.app) ;; *) exit 1 ;; esac
for ((attempt=0; attempt<600; attempt++)); do
  kill -0 "$parent_pid" 2>/dev/null || break
  sleep 0.2
done
kill -0 "$parent_pid" 2>/dev/null && exit 1
/usr/bin/open -n "$application"
