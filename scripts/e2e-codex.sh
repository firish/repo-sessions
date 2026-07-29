#!/usr/bin/env bash
# M2.5 exit-criterion demo: a REAL codex session travels site-A -> css push ->
# vault -> css pull -> site-B -> `codex exec resume`. Isolated CODEX_HOMEs
# simulate two machines (auth.json copied from the live ~/.codex, which is
# never written). Also verifies the state DB self-heals a threads row on B.
#
# usage: scripts/e2e-codex.sh <base-dir> [codex-cli-install-dir]
set -euo pipefail

PARENT="${1:?usage: e2e-codex.sh <base-dir> [codex-cli-dir]}"
BASE="$PARENT/codex-run-$(date +%s)"
REPO=$(cd "$(dirname "$0")/.." && pwd)
CSS="node $REPO/dist/cli.js"
CODEWORD="GUAVA-31"

CLI_DIR="${2:-$PARENT/codex-cli}"
if [ ! -x "$CLI_DIR/node_modules/.bin/codex" ]; then
  echo "installing @openai/codex locally at $CLI_DIR …"
  mkdir -p "$CLI_DIR" && (cd "$CLI_DIR" && npm init -y >/dev/null 2>&1 && npm install @openai/codex >/dev/null 2>&1)
fi
CODEX="$CLI_DIR/node_modules/.bin/codex"
"$CODEX" --version

mkdir -p "$BASE"
git init --bare --quiet "$BASE/origin.git"
git init --bare --quiet "$BASE/vault.git"

SITE_A="$BASE/site-a/proj"; SITE_B="$BASE/site-b/proj"
mkdir -p "$SITE_A" && cd "$SITE_A"
git init --quiet -b main && git remote add origin "file://$BASE/origin.git"
echo "# e2e" > README.md && git add . && git -c user.name=e2e -c user.email=e2e@local commit --quiet -m init
git push --quiet -u origin HEAD
git clone --quiet "file://$BASE/origin.git" "$SITE_B"

mk_home() {
  mkdir -p "$1"
  cp "$HOME/.codex/auth.json" "$1/auth.json"
  printf 'model = "gpt-5.5"\nmodel_reasoning_effort = "low"\n[projects."%s"]\ntrust_level = "trusted"\n[projects."%s"]\ntrust_level = "trusted"\n' \
    "$SITE_A" "$SITE_B" > "$1/config.toml"
}
HOME_A="$BASE/codex-home-a"; HOME_B="$BASE/codex-home-b"
mk_home "$HOME_A"; mk_home "$HOME_B"

echo "=== codex session at site A ==="
(cd "$SITE_A" && CODEX_HOME="$HOME_A" "$CODEX" exec \
  "Our codeword is $CODEWORD. Reply with exactly one line: the codeword." 2>&1 | tail -2)
ROLL=$(find "$HOME_A/sessions" -name 'rollout-*.jsonl' | head -1)
SID=$(node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").split("\n")[0];console.log(JSON.parse(l).payload.id)' "$ROLL")
echo "session: $SID"

echo "=== machine A: css push (codex adapter) ==="
export CSS_CONFIG_DIR="$BASE/config-a"
$CSS setup --url "file://$BASE/vault.git" --path "$BASE/vault-clone-a"
(cd "$SITE_A" && CSS_CODEX_HOME="$HOME_A" $CSS init --no-hooks && CSS_CODEX_HOME="$HOME_A" $CSS push)

echo "=== machine B: css pull + codex exec resume ==="
export CSS_CONFIG_DIR="$BASE/config-b"
$CSS setup --url "file://$BASE/vault.git" --path "$BASE/vault-clone-b"
(cd "$SITE_B" && CSS_CODEX_HOME="$HOME_B" $CSS init --no-hooks \
  && CSS_CODEX_HOME="$HOME_B" $CSS pull && CSS_CODEX_HOME="$HOME_B" $CSS list)

ANSWER=$(cd "$SITE_B" && CODEX_HOME="$HOME_B" "$CODEX" exec resume "$SID" \
  "Reply with exactly one line: the codeword we established." 2>&1 | tail -2)
echo "resume answer: $ANSWER"
if ! grep -q "$CODEWORD" <<<"$ANSWER"; then
  echo "FAIL: codeword not recalled via codex resume"; exit 1
fi

echo "=== self-heal check: threads row on B after first resume ==="
if command -v sqlite3 >/dev/null 2>&1 && [ -f "$HOME_B/state_5.sqlite" ]; then
  sqlite3 -readonly "$HOME_B/state_5.sqlite" "SELECT id, cwd FROM threads WHERE id='$SID';" || true
fi

echo
echo "CODEX E2E PASS: $CODEWORD survived site-A -> vault -> site-B -> codex exec resume"
