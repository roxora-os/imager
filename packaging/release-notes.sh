#!/bin/sh
# Print the CHANGELOG.md section for one version: the lines after
# "## <version>" up to the next "## " heading. Exits 1 when there is no such
# section, or it's empty, so a release can't go out with blank notes.
# A version with a suffix (0.1.5-beta.1) is a beta: its notes start by
# saying so. A normal release never carries a "pre-release" line, even if
# the changelog section still has one.
#   packaging/release-notes.sh 5.6.0 [CHANGELOG.md]
set -eu
version="$1"
changelog="${2:-CHANGELOG.md}"
notes=$(awk -v v="$version" '
    /^## / { if (found) exit; found = ($2 == v); next }
    found
' "$changelog")
if [ -z "$(printf '%s' "$notes" | tr -d '[:space:]')" ]; then
    echo "No notes for $version in $changelog" >&2
    exit 1
fi
case "$version" in
    *-*) printf 'A beta version (pre-release): offered only to those who turned on beta versions.\n\n' ;;
esac
# Drop a paragraph that starts with "A pre-release" (up to the next blank line).
printf '%s\n' "$notes" | awk '
    /^A pre-release/ { skip = 1; next }
    skip && /^[[:space:]]*$/ { skip = 0; next }
    !skip
'
