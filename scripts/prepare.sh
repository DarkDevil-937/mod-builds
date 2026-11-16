#!/usr/bin/env bash
# Resolve one exact Starling commit and fetch its matching native-mod build scripts.
# Keep the source and tools on the same fork: adapting mods against a different Horizon tree
# can leave the compile service using stale APIs even when the APK has been updated.
set -euo pipefail

STARLING_REPO=${STARLING_REPO:-DarkDevil-937/starling-rust-26.3}
TOOLS_REPO=${TOOLS_REPO:-$STARLING_REPO}
TOOLS_BRANCH=${TOOLS:-starling}

COMMIT=$(python3 - <<'EOF'
import json, os, sys
versions = json.load(open("versions.json"))
version = os.environ["VERSION"]
if version not in versions:
    sys.exit(f"No commit for version {version!r} in versions.json")
print(versions[version])
EOF
)
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "Not a commit: $COMMIT"; exit 1; }
echo "COMMIT=$COMMIT" >> "$GITHUB_ENV"
echo "Starling source: $STARLING_REPO@$COMMIT"
echo "Starling build scripts: $TOOLS_REPO@$TOOLS_BRANCH"

mkdir -p tools
for name in mod_build_sandbox.sh mod_build_server.py mod_build_once.py; do
  curl -fsS --retry 5 -o "tools/$name" \
    "https://raw.githubusercontent.com/$TOOLS_REPO/$TOOLS_BRANCH/packaging/android/$name"
done

root=$HOME/modbuild
mkdir -p "$root/jobs" "$root/base"
git init -q "$root/source"
git -C "$root/source" fetch -q --depth 1 "https://github.com/$STARLING_REPO" "$COMMIT"
git -C "$root/source" checkout -q --detach FETCH_HEAD

# What the build reads when it starts, in the sandbox's home.
cat > "$HOME/.profile" <<'EOF'
export ANDROID_HOME=$HOME/android
EOF
