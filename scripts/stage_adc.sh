#!/bin/sh
# Stage a Google ADC credentials file into .container-secrets/mount/ so the
# backend container's non-root user can read it regardless of host file
# ownership (Linux bind mounts enforce host UIDs, and the gcloud ADC file
# is 0600). Secrets live outside .container-data deliberately: that dir is
# bind-mounted read-write at /data on the Apple Container path, and the
# staged copy must not be reachable — let alone writable — through it.
# Spec: docs/superpowers/specs/2026-07-21-seamless-adc-design.md
#
# Exit 0: staged, or no ADC found (GCS features stay off).
# Exit 1: an ADC file was configured or found but is unusable.
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
stage_root="${STAGE_ROOT:-$repo_dir/.container-secrets}"  # STAGE_ROOT is a test seam
mount_dir="$stage_root/mount"
staged_file="$mount_dir/adc.json"

# The mount dir must exist even without an ADC file — both runtimes
# mount it unconditionally. 0700 on the root keeps the 0644 staged copy
# away from other host users; bind mounts ignore host ancestor perms.
mkdir -p "$mount_dir"
chmod 0700 "$stage_root"
chmod 0755 "$mount_dir"

# Migration: earlier revisions staged into .container-data/secrets, which
# is reachable read-write through the Apple path's /data mount — remove
# any credential copy left there.
rm -f "$repo_dir/.container-data/secrets/adc.json"

if [ -n "${GOOGLE_ADC_FILE:-}" ]; then
  source_file=$GOOGLE_ADC_FILE
  explicit=1
elif [ -n "${CLOUDSDK_CONFIG:-}" ]; then
  source_file="$CLOUDSDK_CONFIG/application_default_credentials.json"
  explicit=0
else
  source_file="${HOME:-}/.config/gcloud/application_default_credentials.json"
  explicit=0
fi

if [ ! -e "$source_file" ]; then
  if [ "$explicit" -eq 1 ]; then
    echo "stage_adc: GOOGLE_ADC_FILE points to '$source_file' but no such file exists" >&2
    exit 1
  fi
  rm -f "$staged_file"
  echo "stage_adc: no ADC found - GCS import disabled (run 'gcloud auth application-default login' to enable)"
  exit 0
fi

if [ ! -r "$source_file" ]; then
  echo "stage_adc: '$source_file' exists but is not readable - fix with: chmod u+r '$source_file'" >&2
  exit 1
fi

cp "$source_file" "$staged_file"
chmod 0644 "$staged_file"
echo "stage_adc: staged '$source_file' -> $staged_file"
