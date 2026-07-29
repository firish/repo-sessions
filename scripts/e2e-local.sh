#!/usr/bin/env bash
# M2 exit-criterion demo, fully local: a REAL claude session travels between
# two simulated machines with NO manual css push/pull — sync rides the git
# hooks installed by `css enable`, exactly as it will for real users:
#
#   site-A session -> git push (pre-push hook) -> vault
#   site-B git pull (post-merge hook) -> claude --resume works
#   site-B git push (pre-push hook) -> vault
#   site-A `css hook session-start` -> SessionStart notice JSON
#
# Two CSS_CONFIG_DIRs simulate two machines; ~/.claude is shared but the
# adapter's cwd filtering keeps the "devices" apart.
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

echo "=== machine A: init + enable (installs git hooks) ==="
export CSS_CONFIG_DIR="$BASE/config-a"
$CSS setup --url "file://$BASE/vault.git" --path "$BASE/vault-clone-a"
(cd "$SITE_A" && $CSS init && $CSS hooks status)

echo "=== machine A: plain git push must sync the session (pre-push hook) ==="
cd "$SITE_A"
echo "work" >> README.md && git -c user.name="e2e" -c user.email="e2e@local" commit --quiet -am "work"
git push --quiet
if ! $CSS list | grep -q "synced"; then
  echo "FAIL: session not in vault after plain git push"; exit 1
fi
echo "pre-push hook synced the session"

echo "=== machine B: clone project, init css, enable ==="
git clone --quiet "file://$BASE/origin.git" "$BASE/site-b/proj"
SITE_B="$BASE/site-b/proj"
export CSS_CONFIG_DIR="$BASE/config-b"
$CSS setup --url "file://$BASE/vault.git" --path "$BASE/vault-clone-b"
node -e 'const f=process.argv[1]+"/config.json",fs=require("fs"),c=JSON.parse(fs.readFileSync(f,"utf8"));c.device="laptop-b-sim";fs.writeFileSync(f,JSON.stringify(c,null,2))' "$CSS_CONFIG_DIR"
(cd "$SITE_B" && $CSS init)

echo "=== negative control: resume on B before any pull (must fail) ==="
cd "$SITE_B"
NEG=$(claude -p --model haiku --resume "$SID" "codeword?" 2>&1 || true)
echo "resume-before-pull said: $NEG"
if ! grep -q "No conversation found" <<<"$NEG"; then
  echo "FAIL: expected 'No conversation found' before pull"; exit 1
fi
echo "negative control OK: session invisible before pull"

echo "=== machine B: plain git pull must deliver the session (post-merge hook) ==="
cd "$SITE_A"
echo "more" >> README.md && git -c user.name="e2e" -c user.email="e2e@local" commit --quiet -am "more work"
git push --quiet
cd "$SITE_B" && git pull --quiet
sleep 4   # post-merge pull runs in the background
if ! $CSS list | grep -q "synced"; then
  echo "FAIL: session not installed after plain git pull"; exit 1
fi
echo "post-merge hook installed the session"

ANSWER=$(cd "$SITE_B" && claude -p --model haiku --resume "$SID" \
  "Reply with exactly one line: the codeword we established.")
echo "resume answer: $ANSWER"
if ! grep -q "$CODEWORD" <<<"$ANSWER"; then
  echo "FAIL: codeword not recalled after hook-driven round-trip"; exit 1
fi

echo "=== machine B: git push carries the resumed turns back ==="
cd "$SITE_B"
echo "b-work" >> README.md && git -c user.name="e2e" -c user.email="e2e@local" commit --quiet -am "b work"
git push --quiet
if ! $CSS status | grep -q "1 synced"; then
  echo "FAIL: B's resumed turns not synced by pre-push hook"; exit 1
fi

echo "=== machine A: SessionStart hook pulls and announces ==="
export CSS_CONFIG_DIR="$BASE/config-a"
NOTICE=$(cd "$SITE_A" && $CSS hook session-start)
echo "session-start output: $NOTICE"
if ! grep -q "hookSpecificOutput" <<<"$NOTICE"; then
  echo "FAIL: SessionStart hook produced no sync notice"; exit 1
fi

echo
echo "E2E PASS: $CODEWORD flowed A -> git push -> vault -> git pull -> B -> resume,"
echo "          and back to A via the SessionStart hook. No manual css sync commands."
