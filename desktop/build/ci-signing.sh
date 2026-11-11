#!/bin/bash
# The signing material for a release build in GitHub Actions (.github/workflows/release.yml), and nothing else.
#
#   bash desktop/build/ci-signing.sh load       the workflow's one step that reads signing secrets. It leaves a
#                                               temporary keychain with the Developer ID certificate, the notarization
#                                               key in a private folder, and APPLE_API_KEY (the key's path),
#                                               APPLE_API_KEY_ID and APPLE_API_ISSUER in $GITHUB_ENV for the build.
#   bash desktop/build/ci-signing.sh check      after load, in the signing check only: asks Apple whether it accepts the
#                                               notarization key. Builds nothing.
#   bash desktop/build/ci-signing.sh cleanup    deletes the keychain and the folder. The workflow runs it even after a
#                                               failure, before anything is uploaded.
#   bash desktop/build/ci-signing.sh rehearse   the dry run's proof of the steps that need no secret: the pinned
#                                               1Password CLI downloaded and started, and the keychain install with a
#                                               throwaway self-signed identity made here, a file signed with it, then
#                                               cleanup.
#
# Where the secrets live (Dan, 2026-11-10, "A"): only in the "Yes Chef Release" vault in Dan's family 1Password
# account. A read-only service account reads that vault and nothing else; GitHub holds only its token, as
# OP_SERVICE_ACCOUNT_TOKEN in the main-only `release` Environment. fetch_material reads the items with the pinned
# 1Password CLI (`op read` to files here, not 1Password's GitHub action, which drops line breaks from files); the rest
# of load does not know where the values came from.
#
# It runs only in GitHub Actions on macOS, on a runner GitHub throws away after the job. Nothing here prints a secret:
# GitHub masks the token, the certificate password, the keychain password and the two IDs are masked before use,
# values are checked by pattern with their contents never echoed, items are listed by field label and file name only,
# and every security command's output goes to /dev/null or is counted. `security import -P` and `create-keychain -p`
# take passwords as arguments, as electron-builder's and T3 Code's keychain steps do; on a single-use runner the only
# other processes are this job's.
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
# The 1Password CLI, pinned: version 2.41.1 (released 2026-10-21), its macOS arm64 zip from 1Password's download
# server, the zip's SHA-256 and the binary's signing team (AgileBits, the same team as the 1Password app), read on
# 2026-11-10.
CLI_VERSION=2.41.1
CLI_URL=https://cache.agilebits.com/dist/1P/op2/pkg/v$CLI_VERSION/op_darwin_arm64_v$CLI_VERSION.zip
CLI_SHA256=2289771b68b521ee3dc1d63a013a6a1c5691e0c53e4c4fe79af8042b6ad3c7f5
CLI_TEAM=2BUA8C4S2C
# Yes Chef's Apple team (release plan, section 2).
TEAM_ID=8J2K26SZNK
# The vault and its two items (release plan, Dan's actions 6 to 8). Names, not secrets.
VAULT="Yes Chef Release"
CERT_ITEM="Developer ID Application"
KEY_ITEM="Yes Chef notarization"

die() { echo "ci-signing.sh: $*" >&2; exit 1; }

# Hides $1 in the job's log. A workflow command ends at a line break, so each line is masked on its own, with "%" and
# carriage returns escaped as the runner expects. Otherwise the later lines of a multiline value would print as is.
mask() {
  local line
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -n $line ]] || continue
    line=${line//%/%25}
    line=${line//$'\r'/%0D}
    printf '::add-mask::%s\n' "$line"
  done <<<"$1"
}

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
  local kc found
  while IFS= read -r kc; do
    # Captured first: under pipefail a grep -q that stops reading early can fail the pipe it ends.
    found=$("$SECURITY" find-certificate -a -Z -c "Developer ID Certification Authority" "$kc" 2>/dev/null || true)
    # Whole lines lowercased: security prints "SHA-256 hash: F16C...", so lowercasing only A-F would leave "SHa-256".
    [[ "$(tr '[:upper:]' '[:lower:]' <<<"$found")" == *"sha-256 hash: $G2_SHA256"* ]] && return 0
  done < <(search_list; echo /Library/Keychains/System.keychain)
  return 1
}

# Apple's G2 intermediate into $1, checked against the pinned SHA-256.
fetch_g2() {
  curl -fsSL --retry 3 "$G2_URL" -o "$1" || die "could not download $G2_URL"
  [[ "$(shasum -a 256 "$1" | cut -d' ' -f1)" == "$G2_SHA256" ]] || die "$G2_URL does not match the pinned SHA-256"
}

# The pinned 1Password CLI into $DIR/cli, checked by the zip's SHA-256 and the binary's signing team. Sets CLI.
install_cli() {
  local zip="$DIR/cli.zip" info
  curl -fsSL --retry 3 "$CLI_URL" -o "$zip" || die "could not download $CLI_URL"
  [[ "$(shasum -a 256 "$zip" | cut -d' ' -f1)" == "$CLI_SHA256" ]] || die "$CLI_URL does not match the pinned SHA-256"
  mkdir "$DIR/cli"
  /usr/bin/ditto -x -k "$zip" "$DIR/cli"
  rm -f "$zip"
  CLI="$DIR/cli/op"
  /usr/bin/codesign --verify --strict "$CLI" 2>/dev/null || die "the 1Password CLI's signature does not verify."
  info=$(/usr/bin/codesign -dv "$CLI" 2>&1)
  grep -qx "TeamIdentifier=$CLI_TEAM" <<<"$info" || die "the 1Password CLI is not signed by team $CLI_TEAM."
  # Its settings stay in the folder cleanup deletes, and it keeps no cache.
  mkdir -m 700 "$DIR/cli-config"
  export OP_CONFIG_DIR="$DIR/cli-config" OP_CACHE=false
}

# An item's shape, never its values: its category, its files' ids and names, and its fields' ids, labels, types and
# purposes. One CLI call.
item_shape() {
  local json
  json=$("$CLI" item get "$1" --vault "$VAULT" --format json) \
    || die "could not read the item \"$1\" in \"$VAULT\". Check the token and the service account's access to the vault."
  jq -c '{category, files: [.files[]? | {id, name}], fields: [.fields[]? | {id, label, type, purpose}]}' <<<"$json"
}

# Field labels and file names from a shape, for an error message.
shape_note() { jq -r '"Its fields: " + ([.fields[] | "\(.label) (\(.type))"] | join(", ")) + ". Its files: " + ([.files[].name] | join(", ")) + "."' <<<"$1"; }

# The reference to the one file in item $2 (shape $1) whose name ends with $3, or nothing. By name, as the local
# fallback reads the key; by the file's id when the name has characters a reference cannot hold.
file_ref() {
  local f id name
  f=$(jq -r --arg ext "$3" '[.files[] | select(.name | ascii_downcase | endswith($ext))] | if length == 1 then "\(.[0].id)\t\(.[0].name)" else empty end' <<<"$1")
  [[ -n $f ]] || return 0
  id=${f%%$'\t'*}
  name=${f#*$'\t'}
  if [[ $name =~ ^[A-Za-z0-9\ ._-]+$ ]]; then printf 'op://%s/%s/%s' "$VAULT" "$2" "$name"; else printf 'op://%s/%s/%s' "$VAULT" "$2" "$id"; fi
}

# The id of the certificate's password: the one field 1Password marks as a password, else the one concealed field.
password_field() {
  jq -r '[.fields[] | select(.purpose == "PASSWORD")] as $p | [.fields[] | select(.type == "CONCEALED")] as $c
    | if ($p | length) == 1 then $p[0].id elif ($c | length) == 1 then $c[0].id else empty end' <<<"$1"
}

# Where the secrets live: the "Yes Chef Release" vault, read with the service account's token from this step's
# environment. Seven CLI calls (two items' shapes, two files, three fields), plus one for the usage; 1Password says
# some calls make more than one request. Writes $DIR/cert.p12 and $DIR/AuthKey.p8,
# sets P12_PASSWORD, KEY_ID and ISSUER, each masked as soon as it is read.
fetch_material() {
  [[ -n "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]] || die "OP_SERVICE_ACCOUNT_TOKEN is empty. Dan's one-time setup puts it in the release Environment (release plan, Dan's actions 9 and 10)."
  install_cli
  local cert key ref field
  cert=$(item_shape "$CERT_ITEM")
  key=$(item_shape "$KEY_ITEM")

  # The certificate: a .p12 attached to the item, or the item itself when it is a Document.
  if [[ "$(jq -r .category <<<"$cert")" == DOCUMENT ]]; then
    "$CLI" document get "$CERT_ITEM" --vault "$VAULT" --out-file "$DIR/cert.p12" >/dev/null \
      || die "could not read the document \"$CERT_ITEM\" in \"$VAULT\"."
  else
    ref=$(file_ref "$cert" "$CERT_ITEM" .p12)
    [[ -n $ref ]] || die "expected one .p12 attached to \"$CERT_ITEM\" in \"$VAULT\". $(shape_note "$cert")"
    "$CLI" read --out-file "$DIR/cert.p12" "$ref" >/dev/null || die "could not read the .p12 from \"$CERT_ITEM\"."
  fi
  field=$(password_field "$cert")
  [[ -n $field ]] || die "expected one password field in \"$CERT_ITEM\". $(shape_note "$cert")"
  P12_PASSWORD=$("$CLI" read --no-newline "op://$VAULT/$CERT_ITEM/$field") || die "could not read the password from \"$CERT_ITEM\"."
  mask "$P12_PASSWORD"

  # The notarization key, as the local fallback reads it: one .p8 attached, and fields "key id" and "issuer id".
  ref=$(file_ref "$key" "$KEY_ITEM" .p8)
  [[ -n $ref ]] || die "expected one .p8 attached to \"$KEY_ITEM\" in \"$VAULT\". $(shape_note "$key")"
  "$CLI" read --out-file "$DIR/AuthKey.p8" "$ref" >/dev/null || die "could not read the .p8 from \"$KEY_ITEM\"."
  KEY_ID=$("$CLI" read --no-newline "op://$VAULT/$KEY_ITEM/key id") || die "expected a field \"key id\" in \"$KEY_ITEM\". $(shape_note "$key")"
  mask "$KEY_ID"
  ISSUER=$("$CLI" read --no-newline "op://$VAULT/$KEY_ITEM/issuer id") || die "expected a field \"issuer id\" in \"$KEY_ITEM\". $(shape_note "$key")"
  mask "$ISSUER"

  echo "Read from \"$VAULT\": the certificate ($(wc -c < "$DIR/cert.p12" | tr -d ' ') bytes) and its password, the notarization key ($(wc -c < "$DIR/AuthKey.p8" | tr -d ' ') bytes), its key ID and its issuer ID."
  # Usage against 1Password's limits for Families: 1,000 reads an hour per token, and 1,000 requests a day for the
  # whole account (developer.1password.com, "Service account rate limits", read 2026-11-10).
  "$CLI" service-account ratelimit 2>/dev/null || echo "The service account's rate limit usage: not checked."
  unset OP_SERVICE_ACCOUNT_TOKEN
}

# A temporary keychain with the identity in $1 (a .p12) and password $2, first in the search list, unlocked for six
# hours, with codesign allowed to use the key without a prompt. Deletes the .p12. Prints only counts.
install_identity() {
  local p12=$1 password=$2 keychain_password
  keychain_password=$(/usr/bin/openssl rand -hex 32)
  mask "$keychain_password"
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
  # The PEM header, written as a pattern so the public tree scan (tools/public-tree.ts) does not read it as a key.
  grep -qE -- '^-{5}BEGIN PRIVATE KEY-{5}' "$DIR/AuthKey.p8" || die "the .p8 is not a private key."
  install_identity "$DIR/cert.p12" "$P12_PASSWORD"
  unset P12_PASSWORD
  local valid
  valid=$("$SECURITY" find-identity -v -p codesigning "$KEYCHAIN" | grep -c "\"Developer ID Application: .* ($TEAM_ID)\"" || true)
  [[ "$valid" -ge 1 ]] || die "the keychain has no valid Developer ID Application identity from team $TEAM_ID (all: $(count_identities), valid: $(count_identities -v))."
  {
    echo "APPLE_API_KEY=$DIR/AuthKey.p8"
    echo "APPLE_API_KEY_ID=$KEY_ID"
    echo "APPLE_API_ISSUER=$ISSUER"
  } >> "$GITHUB_ENV"
  echo "Signing loaded: $valid Developer ID Application identity from team $TEAM_ID in a temporary keychain; the notarization key is in a private folder."
}

# After load, in the signing check only: whether Apple accepts the notarization key. One notarytool call, which
# notarizes nothing; it prints only a count.
check() {
  [[ -f "${APPLE_API_KEY:-}" && -n "${APPLE_API_KEY_ID:-}" && -n "${APPLE_API_ISSUER:-}" ]] || die "run load first."
  local out
  out=$(/usr/bin/xcrun notarytool history --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --output-format json 2>&1) \
    || die "Apple did not accept the notarization key: $(sed -n 1,3p <<<"$out" | tr '\n' ' ')"
  echo "Apple accepted the notarization key and listed $(jq '.history | length' <<<"$out") of the team's submissions."
}

cleanup() {
  if [[ -e "$KEYCHAIN" ]]; then "$SECURITY" delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true; fi
  rm -rf "$DIR"
  # The list is captured first: under pipefail a grep -q that stops reading early can fail the pipe and hide a match.
  local list
  list=$(search_list)
  if [[ -e "$DIR" ]] || grep -qxF "$KEYCHAIN" <<<"$list"; then die "the signing keychain or folder is still here."; fi
  echo "Signing keychain and key folder deleted."
}

rehearse() {
  [[ ! -e "$DIR" ]] || die "$DIR already exists."
  mkdir "$DIR"
  local work="$DIR/rehearsal" password
  mkdir "$work"
  password=$(/usr/bin/openssl rand -hex 16)
  mask "$password"
  # A throwaway identity, trusted by nothing, made and deleted inside this step.
  # The extensions come from a config file, which every OpenSSL and LibreSSL reads; LibreSSL before 3.x has no -addext.
  printf '%s\n' '[req]' 'distinguished_name = dn' 'x509_extensions = ext' 'prompt = no' \
    '[dn]' 'CN = Yes Chef CI rehearsal' \
    '[ext]' 'keyUsage = critical,digitalSignature' 'extendedKeyUsage = critical,codeSigning' >"$work/req.cnf"
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 1 -config "$work/req.cnf" \
    -keyout "$work/key.pem" -out "$work/cert.pem" >/dev/null 2>&1 || die "openssl could not make the rehearsal certificate."
  /usr/bin/openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" -out "$DIR/cert.p12" -passout "pass:$password"
  rm -f "$work/key.pem"
  # The CLI that reads the vault in a release, with no token: downloaded, checked against the pins, started.
  local version
  install_cli
  version=$("$CLI" --version)
  [[ "$version" == "$CLI_VERSION" ]] || die "the 1Password CLI says version $version, not $CLI_VERSION."
  install_identity "$DIR/cert.p12" "$password"
  [[ ! -e "$DIR/cert.p12" ]] || die "the .p12 was not deleted after import."
  local all hash list
  all=$(count_identities)
  [[ "$all" -ge 1 ]] || die "the rehearsal identity did not import."
  list=$(search_list)
  [[ "$(sed -n 1p <<<"$list")" == "$KEYCHAIN" ]] || die "the temporary keychain is not first in the search list."
  hash=$("$SECURITY" find-identity -p codesigning "$KEYCHAIN" | grep -oE '[0-9A-F]{40}' | sed -n 1p)
  cp /usr/bin/true "$work/true"
  # Signs with no prompt only if the partition list is right; a prompt would hang until the step's timeout.
  /usr/bin/codesign --force --sign "$hash" --keychain "$KEYCHAIN" "$work/true" >/dev/null 2>&1 || die "codesign could not use the rehearsal identity."
  /usr/bin/codesign --verify --strict "$work/true" || die "the rehearsal signature does not verify."
  fetch_g2 "$work/g2.cer"
  echo "Rehearsal: the 1Password CLI $version downloaded, matched to its pins and started; $all identity imported, the keychain first in the search list, a file signed with no prompt, Apple's G2 intermediate downloaded and matched to the pin."
  cleanup
}

case "${1:-}" in
  load) load ;;
  cleanup) cleanup ;;
  check) check ;;
  rehearse) rehearse ;;
  *) die "usage: ci-signing.sh load | check | cleanup | rehearse" ;;
esac
