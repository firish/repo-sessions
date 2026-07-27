#!/usr/bin/env bash
# M1 exit-criterion demo, fully local: a REAL claude session travels
# site-A -> css push -> vault -> css pull -> site-B -> claude --resume.
# Two CSS_CONFIG_DIRs simulate two machines; ~/.claude is shared but the
# adapter's cwd filtering keeps the "devices" apart (that is the point).
#
# usage: scripts/e2e-local.sh <base-dir>
set -euo pipefail

BASE="${1:?usage: e2e-local.sh <base-dir>}/run-$(date +%s)"
REPO=$(cd "$(dirname "$0")/.." && pwd)
CSS="node $REPO/dist/cli.js"
CODEWORD="PAPAYA-99"

# nested-claude hygiene: drop the parent session's env
for v in $(env | cut -d= -f1 | grep '^CLAUDE' || true); do unset "$v"; done

mkdir -p "$BASE"
git init --bare --quiet "$BASE/origin.git"
git init --bare --quiet "$BASE/vault.git"

echo "=== site A: project + real claude session ==="
SITE_A="$BASE/site-a/proj"
mkdir -p "$SITE_A" && cd "$SITE_A"
git init --quiet -b main && git remote add origin "file://$BASE/origin.git"
echo "# e2e fixture" > README.md && git add README.md
git -c user.name="e2e" -c user.email="e2e@local" commit --quiet -m "init"
git push --quiet -u origin HEAD

SID=$(claude -p --model haiku --output-format json \
  "Our codeword is $CODEWORD. Reply with exactly one line: the codeword." \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).session_id))')
echo "session: $SID"

echo "=== machine A: init + enable + push ==="
export CSS_CONFIG_DIR="$BASE/config-a"
$CSS init --url "file://$BASE/vault.git" --path "$BASE/vault-clone-a"
(cd "$SITE_A" && $CSS enable && $CSS push)

echo "=== machine B: clone project, init css ==="
git clone --quiet "file://$BASE/origin.git" "$BASE/site-b/proj"
SITE_B="$BASE/site-b/proj"
export CSS_CONFIG_DIR="$BASE/config-b"
$CSS init --url "file://$BASE/vault.git" --path "$BASE/vault-clone-b"
node -e 'const f=process.argv[1]+"/config.json",fs=require("fs"),c=JSON.parse(fs.readFileSync(f,"utf8"));c.device="laptop-b-sim";fs.writeFileSync(f,JSON.stringify(c,null,2))' "$CSS_CONFIG_DIR"

echo "=== negative control: resume on B before pull (must fail) ==="
cd "$SITE_B"
NEG=$(claude -p --model haiku --resume "$SID" "codeword?" 2>&1 || true)
echo "resume-before-pull said: $NEG"
if grep -q "No conversation found" <<<"$NEG"; then
  echo "negative control OK: session invisible before pull"
else
  echo "FAIL: expected 'No conversation found' before pull"; exit 1
fi

echo "=== machine B: enable + pull + resume ==="
(cd "$SITE_B" && $CSS enable && $CSS pull && $CSS list)
ANSWER=$(cd "$SITE_B" && claude -p --model haiku --resume "$SID" \
  "Reply with exactly one line: the codeword we established.")
echo "resume answer: $ANSWER"
if ! grep -q "$CODEWORD" <<<"$ANSWER"; then
  echo "FAIL: codeword not recalled after vault round-trip"; exit 1
fi

echo "=== push-back check: B's resume appended turns, sync them ==="
(cd "$SITE_B" && $CSS push && $CSS status)

echo
echo "E2E PASS: $CODEWORD survived site-A -> vault -> site-B -> claude --resume"
