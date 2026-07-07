#!/usr/bin/env bash
# Usage: pipeline-rename-job.sh <issue> <title>
# Renames the CURRENT background job to a clean, issue-derived title of the
# form "#<issue> <slug>" (e.g. "#142 pkpd warning"), so a wall of parallel
# pipeline jobs is legible at a glance instead of carrying an auto-generated
# name derived from the first prompt.
#
# The background job's title lives in the "name" field of the job's
# state.json, at $CLAUDE_JOB_DIR/state.json. The harness stamps
# "nameSource": "auto" on a title it generated and will keep re-deriving
# such a title; writing "nameSource": "user" pins the name so the harness
# leaves it alone. This script sets both fields together.
#
# This script ships INSIDE the plugin (at scripts/pipeline-rename-job.sh)
# and the pipeline skills invoke it via the plugin-root path variable,
# `bash "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-rename-job.sh" ...`, so it
# never needs copying into a target repo.
#
# Safe outside a background job: if $CLAUDE_JOB_DIR is unset or its
# state.json is absent (a pipeline run in the foreground), this is a silent
# no-op, not an error, so the same setup step works in every context.
set -euo pipefail

issue="$1"
title="${2:-}"

# No background job to rename (foreground run): nothing to do.
if [[ -z "${CLAUDE_JOB_DIR:-}" ]]; then
  exit 0
fi

state_file="$CLAUDE_JOB_DIR/state.json"
if [[ ! -f "$state_file" ]]; then
  exit 0
fi

# Slugify the title: lowercase, drop anything that is not a letter, digit,
# or space, collapse whitespace to single spaces, trim, and cap the length
# so the job list stays scannable. A leading "#N" was often already stripped
# by the caller, but strip a leading issue-number token defensively so we do
# not produce "#142 142 ...".
slug=$(printf '%s' "$title" \
  | tr '[:upper:]' '[:lower:]' \
  | sed -E 's/[^a-z0-9 ]+/ /g; s/[[:space:]]+/ /g; s/^ //; s/ $//' \
  | sed -E "s/^#?${issue} //" \
  | cut -c1-40 \
  | sed -E 's/ $//')

# Prefix a numeric GitHub issue with "#" (e.g. "#142"); leave a local
# L-prefixed id bare (e.g. "L3"), since "#L3" reads oddly and the repo
# already writes local ids without a leading "#".
if [[ "$issue" =~ ^[0-9]+$ ]]; then
  label="#$issue"
else
  label="$issue"
fi

if [[ -n "$slug" ]]; then
  name="$label $slug"
else
  name="$label"
fi

# Temp-file-plus-rename so a session killed mid-write cannot leave a torn
# state.json. The temp file is a sibling so the rename is atomic (same
# filesystem).
tmp_file=$(mktemp "$CLAUDE_JOB_DIR/.state.json.XXXXXX")
trap 'rm -f "$tmp_file"' EXIT
jq --arg name "$name" '.name = $name | .nameSource = "user"' "$state_file" >"$tmp_file"
mv "$tmp_file" "$state_file"
trap - EXIT

echo "Renamed job to: $name" >&2
