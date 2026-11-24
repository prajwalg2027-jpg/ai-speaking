#!/usr/bin/env bash
# Builds the signed Google Play bundle (.aab) on this Mac.
#
#   ./android/release.sh 2          # versionCode 2 (each Play upload needs a higher number than the last)
#
# Signing comes from ~/.adam-release/signing.properties (outside the repository, never commit it):
#   storeFile=/Users/<you>/.adam-release/adam-upload.jks
#   storePassword=...
#   keyAlias=upload
#   keyPassword=...
# That keystore is the Play *upload* key. Google re-signs the app with its own key (Play App Signing), so if the
# upload key is lost, the Play Console can reset it. Keep a backup of the file and its password anyway.
#
# Output: android/app/build/outputs/bundle/release/app-release.aab, copied to
#         ~/.adam-release/adam-<versionName>-<versionCode>.aab
set -euo pipefail

VERSION_CODE="${1:?Give the versionCode, e.g. ./android/release.sh 1}"
PROPS="${SAKHI_SIGNING_PROPERTIES:-$HOME/.adam-release/signing.properties}"
[[ -f "$PROPS" ]] || { echo "No signing file at $PROPS (see the comment at the top of this script)." >&2; exit 1; }
prop() { grep -E "^$1=" "$PROPS" | head -1 | cut -d= -f2-; }

export JAVA_HOME="${JAVA_HOME:-$(/usr/libexec/java_home -v 21 2>/dev/null || echo /opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home)}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
export SAKHI_KEYSTORE_FILE="$(prop storeFile)"
export SAKHI_KEYSTORE_PASSWORD="$(prop storePassword)"
export SAKHI_KEY_ALIAS="$(prop keyAlias)"
export SAKHI_KEY_PASSWORD="$(prop keyPassword)"

cd "$(dirname "$0")"
./gradlew --no-configuration-cache :app:bundleRelease -Psakhi.versionCode="$VERSION_CODE"

AAB=app/build/outputs/bundle/release/app-release.aab
NAME="$(grep -o 'versionName = "[^"]*"' app/build.gradle.kts | cut -d'"' -f2)"
OUT="$(dirname "$PROPS")/adam-${NAME}-${VERSION_CODE}.aab"
cp "$AAB" "$OUT"
echo
echo "Signed bundle: $OUT"
"$JAVA_HOME/bin/keytool" -printcert -jarfile "$OUT" | grep -E "Owner|SHA256:" | head -2
