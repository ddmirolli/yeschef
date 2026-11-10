#!/bin/bash
# The signing material for a release build in GitHub Actions (.github/workflows/release.yml), and nothing else.
#
#   bash desktop/build/ci-signing.sh load       the workflow's one step that reads signing secrets. It leaves a
#                                               temporary keychain with the Developer ID certificate, the notarization
#                                               key in a private folder, and APPLE_API_KEY (the key's path),
#                                               APPLE_API_KEY_ID and APPLE_API_ISSUER in $GITHUB_ENV for the build.
#   bash desktop/build/ci-signing.sh cleanup    deletes the keychain and the folder. The workflow runs it even after a
#                                               failure, before anything is uploaded.
#   bash desktop/build/ci-signing.sh rehearse   the dry run's proof of the keychain steps before any secret exists: the
#                                               same install with a throwaway self-signed identity made here, a file
#                                               signed with it, then cleanup.
#
# `load` has two halves. fetch_material gets the five values from wherever they live; install_material does the
# rest. Only fetch_material knows where the secrets come from, so moving them changes that function alone.
#
# It runs only in GitHub Actions on macOS, on a runner GitHub throws away after the job. Nothing here prints a secret:
# GitHub masks secret values in the log, the keychain password and the two IDs are masked before use, values are
# checked by pattern with their contents never echoed, and every security command's output goes to /dev/null or is
# counted. `security import -P` and `create-keychain -p` take passwords as arguments, as electron-builder's and T3 Code's
# keychain steps do; on a single-use runner the only other processes are this job's.
set -euo pipefail
umask 077

if [[ "${GITHUB_ACTIONS:-}" != true || "$(uname -s)" != Darwin || -z "${RUNNER_TEMP:-}" || -z "${GITHUB_ENV:-}" ]]; then
  echo "ci-signing.sh runs only in GitHub Actions on macOS." >&2
  exit 1
fi

DIR="$RUNNER_TEMP/yeschef-signing"
KEYCHAIN="$DIR/signing.keychain-db"
SECURITY=/usr/bin/security
# Apple's Developer ID G2 intermediate, which issued Yes Chef's Developer ID certificate (release plan, section 2).
# codesign needs it to build the chain. SHA-256 read on 2026-11-10 from the copy in a Mac's login keychain and from
# apple.com/certificateauthority/DeveloperIDG2CA.cer; both matched.
G2_URL=https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer
G2_SHA256=f16cd3c54c7f83cea4bf1a3e6a0819c8aaa8e4a1528fd144715f350643d2df3a

die() { echo "ci-signing.sh: $*" >&2; exit 1; }

# The keychains codesign searches, one path per line.
search_list() {
  local line
  while IFS= read -r line; do
    line=${line#*\"}; line=${line%\"*}
    [[ -n $line ]] && printf '%s\n' "$line"
  done < <("$SECURITY" list-keychains -d user)
}

# Whether this Mac already has the G2 intermediate, in the search list or the System keychain.
has_g2() {
  local kc
  while IFS= read -r kc; do
    "$SECURITY" find-certificate -a -Z -c "Developer ID Certification Authority" "$kc" 2>/dev/null \
      | tr 'A-F' 'a-f' | grep -q "sha-256 hash: $G2_SHA256" && return 0
  done < <(search_list; echo /Library/Keychains/System.keychain)
  return 1
}

# Apple's G2 intermediate into $1, checked against the pinned SHA-256.
fetch_g2() {
  curl -fsSL --retry 3 "$G2_URL" -o "$1" || die "could not download $G2_URL"
  [[ "$(shasum -a 256 "$1" | cut -d' ' -f1)" == "$G2_SHA256" ]] || die "$G2_URL does not match the pinned SHA-256"
}

# Where the secrets live: GitHub secrets in the main-only `release` Environment, given to this step's environment
# by the workflow as CSC_LINK (the .p12, base64), CSC_KEY_PASSWORD, APPLE_API_KEY (the .p8 text), APPLE_API_KEY_ID
# and APPLE_API_ISSUER, as T3 Code names them. Writes $DIR/cert.p12 and $DIR/AuthKey.p8, sets P12_PASSWORD,
# KEY_ID and ISSUER.
fetch_material() {
  local name
  for name in CSC_LINK CSC_KEY_PASSWORD APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER; do
    [[ -n "${!name:-}" ]] || die "the secret $name is empty. Run the one-time setup (release plan, section 7)."
  done
  # Line breaks and spaces are dropped first, so a value wrapped at 64 or 76 columns decodes the same.
  printf '%s' "$CSC_LINK" | tr -d ' \r\n' | /usr/bin/base64 -d > "$DIR/cert.p12" 2>/dev/null || die "CSC_LINK is not base64."
  printf '%s\n' "$APPLE_API_KEY" > "$DIR/AuthKey.p8"
  P12_PASSWORD=$CSC_KEY_PASSWORD
  KEY_ID=$APPLE_API_KEY_ID
  ISSUER=$APPLE_API_ISSUER
}

# A temporary keychain with the identity in $1 (a .p12) and password $2, first in the search list, unlocked for six
# hours, with codesign allowed to use the key without a prompt. Deletes the .p12. Prints only counts.
install_identity() {
  local p12=$1 password=$2 keychain_password
  keychain_password=$(/usr/bin/openssl rand -hex 32)
  echo "::add-mask::$keychain_password"
  "$SECURITY" create-keychain -p "$keychain_password" "$KEYCHAIN"
  "$SECURITY" set-keychain-settings -lut 21600 "$KEYCHAIN"
  "$SECURITY" unlock-keychain -p "$keychain_password" "$KEYCHAIN"
  "$SECURITY" import "$p12" -k "$KEYCHAIN" -f pkcs12 -P "$password" -T /usr/bin/codesign >/dev/null 2>&1 \
    || { rm -f "$p12"; die "the .p12 did not import. Check the certificate and its password."; }
  rm -f "$p12"
  "$SECURITY" set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$KEYCHAIN" >/dev/null 2>&1
  # codesign and electron-builder find the identity, and its certificate chain, through the user's search list.
  local -a list=()
  local kc
  while IFS= read -r kc; do [[ "$kc" == "$KEYCHAIN" ]] || list+=("$kc"); done < <(search_list)
  "$SECURITY" list-keychains -d user -s "$KEYCHAIN" ${list[@]+"${list[@]}"}
  if has_g2; then
    echo "Apple's Developer ID G2 intermediate: on this runner."
  else
    fetch_g2 "$DIR/g2.cer"
    "$SECURITY" import "$DIR/g2.cer" -k "$KEYCHAIN" >/dev/null 2>&1 || die "could not import Apple's G2 intermediate"
    echo "Apple's Developer ID G2 intermediate: added from apple.com (SHA-256 matched the pin)."
  fi
}

# Counts of codesigning identities in the temporary keychain: all, then valid (a trusted chain).
count_identities() { "$SECURITY" find-identity ${1:+"$1"} -p codesigning "$KEYCHAIN" | grep -cE '^ +[0-9]+\) [0-9A-F]{40} ' || true; }

load() {
  [[ ! -e "$DIR" ]] || die "$DIR already exists: a load ran twice in this job."
  mkdir "$DIR"
  fetch_material
  # The two IDs go into $GITHUB_ENV, so they must be exactly what Apple issues: a newline there would add variables.
  [[ "$KEY_ID" =~ ^[A-Z0-9]{10}$ ]] || die "APPLE_API_KEY_ID is not a 10-character key ID."
  [[ "$ISSUER" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || die "APPLE_API_ISSUER is not an issuer ID (a UUID)."
  grep -q -- '-----BEGIN PRIVATE KEY-----' "$DIR/AuthKey.p8" || die "APPLE_API_KEY is not a .p8 private key."
  echo "::add-mask::$KEY_ID"
  echo "::add-mask::$ISSUER"
  install_identity "$DIR/cert.p12" "$P12_PASSWORD"
  unset P12_PASSWORD
  local valid
  valid=$("$SECURITY" find-identity -v -p codesigning "$KEYCHAIN" | grep -c '"Developer ID Application: ' || true)
  [[ "$valid" -ge 1 ]] || die "the keychain has no valid Developer ID Application identity (all: $(count_identities), valid: $(count_identities -v))."
  {
    echo "APPLE_API_KEY=$DIR/AuthKey.p8"
    echo "APPLE_API_KEY_ID=$KEY_ID"
    echo "APPLE_API_ISSUER=$ISSUER"
  } >> "$GITHUB_ENV"
  echo "Signing loaded: $valid Developer ID Application identity in a temporary keychain; the notarization key is in a private folder."
}

cleanup() {
  if [[ -e "$KEYCHAIN" ]]; then "$SECURITY" delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true; fi
  rm -rf "$DIR"
  if [[ -e "$DIR" ]] || search_list | grep -qF "$KEYCHAIN"; then die "the signing keychain or folder is still here."; fi
  echo "Signing keychain and key folder deleted."
}

rehearse() {
  [[ ! -e "$DIR" ]] || die "$DIR already exists."
  mkdir "$DIR"
  local work="$DIR/rehearsal" password
  mkdir "$work"
  password=$(/usr/bin/openssl rand -hex 16)
  echo "::add-mask::$password"
  # A throwaway identity, trusted by nothing, made and deleted inside this step.
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=Yes Chef CI rehearsal" \
    -addext "keyUsage=critical,digitalSignature" -addext "extendedKeyUsage=critical,codeSigning" \
    -keyout "$work/key.pem" -out "$work/cert.pem" >/dev/null 2>&1
  /usr/bin/openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" -out "$DIR/cert.p12" -passout "pass:$password"
  rm -f "$work/key.pem"
  # The same base64 round trip a .p12 makes through a secret, wrapped at 76 columns to prove the unwrapping.
  local wrapped
  wrapped=$(/usr/bin/base64 -b 76 -i "$DIR/cert.p12")
  printf '%s' "$wrapped" | tr -d ' \r\n' | /usr/bin/base64 -d > "$work/round.p12"
  cmp -s "$DIR/cert.p12" "$work/round.p12" || die "the base64 round trip changed the .p12."
  install_identity "$DIR/cert.p12" "$password"
  [[ ! -e "$DIR/cert.p12" ]] || die "the .p12 was not deleted after import."
  local all hash
  all=$(count_identities)
  [[ "$all" -ge 1 ]] || die "the rehearsal identity did not import."
  search_list | head -n 1 | grep -qF "$KEYCHAIN" || die "the temporary keychain is not first in the search list."
  hash=$("$SECURITY" find-identity -p codesigning "$KEYCHAIN" | grep -oE '[0-9A-F]{40}' | head -n 1)
  cp /usr/bin/true "$work/true"
  # Signs with no prompt only if the partition list is right; a prompt would hang until the step's timeout.
  /usr/bin/codesign --force --sign "$hash" --keychain "$KEYCHAIN" "$work/true" >/dev/null 2>&1 || die "codesign could not use the rehearsal identity."
  /usr/bin/codesign --verify --strict "$work/true" || die "the rehearsal signature does not verify."
  fetch_g2 "$work/g2.cer"
  echo "Rehearsal: $all identity imported, the keychain first in the search list, a file signed with no prompt, Apple's G2 intermediate downloaded and matched to the pin."
  cleanup
}

case "${1:-}" in
  load) load ;;
  cleanup) cleanup ;;
  rehearse) rehearse ;;
  *) die "usage: ci-signing.sh load | cleanup | rehearse" ;;
esac
