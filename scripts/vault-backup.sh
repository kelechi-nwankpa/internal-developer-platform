#!/usr/bin/env bash
# vault-backup.sh — copy Vault's data off the kind node onto this Mac.
#
# WHY: Vault's storage is one folder inside the kind node (one Docker
# container). Delete the node or reset Docker's disk and every secret
# goes with it, along with any copy kept inside the node. This puts a
# copy somewhere that survives the node. Run: make vault-backup
#
# WHAT the copy is: Vault's storage files, encrypted by Vault. Without
# the unseal keys it cannot be read. NEVER keep the unseal keys or the
# root token in the same place as these files.
#
# HOW it stays consistent without stopping Vault: Vault keeps running
# (stopping it means unsealing again by hand). The script fingerprints
# the folder on the node, copies it, fingerprints the node again and
# fingerprints the copy. All three must match, which proves nothing
# changed mid-copy. If Vault wrote during the copy it retries.
#
# Alternative rejected: stop Vault first (as the storage repair did).
# Always consistent, but needs three unseal keys typed in after every
# backup, so backups would not get taken.
#
# Restore: docs/runbooks/kind-recovery.md, Failure Mode 8.
#
# Env: VAULT_BACKUP_DIR (default ~/idp-backups/vault), KIND_NODE
#      (default idp-control-plane).
set -euo pipefail

NODE="${KIND_NODE:-idp-control-plane}"
OUT_DIR="${VAULT_BACKUP_DIR:-$HOME/idp-backups/vault}"
ATTEMPTS=3

for t in docker kubectl tar shasum; do
  command -v "$t" >/dev/null 2>&1 || { echo "required tool not found: $t" >&2; exit 1; }
done

# A backup inside a Git working tree is one `git add -A` from being pushed.
# Checked on the nearest folder that already exists, before creating anything.
probe="$OUT_DIR"
while [[ ! -d "$probe" ]]; do probe=$(dirname "$probe"); done
if git -C "$probe" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "refusing: $OUT_DIR is inside a Git repository" >&2
  exit 1
fi
mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

pv=$(kubectl -n vault get pvc data-vault-0 -o jsonpath='{.spec.volumeName}')
src=$(kubectl get pv "$pv" -o jsonpath='{.spec.hostPath.path}')
[[ -n "$src" ]] || { echo "could not find the host path of volume $pv" >&2; exit 1; }

# One line that changes if any file's content, name or presence changes.
node_fingerprint() {
  docker exec "$NODE" sh -c "cd '$src' && find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1"
}
local_fingerprint() {
  (cd "$1" && find . -type f | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | cut -d' ' -f1)
}

stamp=$(date -u +%Y-%m-%dT%H%M%SZ)
out="$OUT_DIR/vault-data-$stamp.tar.gz"
work=$(mktemp -d "${TMPDIR:-/tmp}/vault-backup.XXXXXX")
trap 'rm -rf "${work:?}"' EXIT

ok=0
for attempt in $(seq 1 "$ATTEMPTS"); do
  before=$(node_fingerprint)
  docker exec "$NODE" tar -C "$src" -czf - . >"$work/data.tar.gz"
  after=$(node_fingerprint)

  mkdir -p "$work/check-$attempt"
  tar -C "$work/check-$attempt" -xzf "$work/data.tar.gz"
  copy=$(local_fingerprint "$work/check-$attempt")

  if [[ "$before" == "$after" && "$after" == "$copy" ]]; then
    ok=1
    files=$(find "$work/check-$attempt" -type f | wc -l | tr -d ' ')
    break
  fi
  echo "attempt $attempt: Vault's data changed during the copy, retrying" >&2
  sleep 3
done
[[ $ok -eq 1 ]] || { echo "no consistent copy after $ATTEMPTS attempts; nothing saved" >&2; exit 1; }

# A real Vault store always has these. Guards against copying the wrong folder.
for d in core sys logical; do
  [[ -d "$work/check-$attempt/$d" ]] || { echo "copy has no '$d' folder; not a Vault store? nothing saved" >&2; exit 1; }
done

mv "$work/data.tar.gz" "$out"
chmod 600 "$out"
echo "$copy  $(basename "$out")  files=$files" >>"$OUT_DIR/fingerprints.txt"
chmod 600 "$OUT_DIR/fingerprints.txt"

echo "saved   $out"
echo "files   $files   size $(du -h "$out" | cut -f1 | tr -d ' ')   fingerprint ${copy:0:12}"
echo "note    encrypted by Vault; useless without the unseal keys. Keep the keys elsewhere."
echo "note    take a new backup after every change to a secret."
