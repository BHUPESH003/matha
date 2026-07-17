#!/usr/bin/env bash
# Field test: does a REAL agent (headless Claude Code) actually use matha?
#
# This is the semi-automated version of the field protocol in
# docs/analysis/03-target-architecture.md §3.3. It builds a throwaway
# project with a planted danger zone, connects the PUBLISHED matha over
# MCP, and runs two headless agent sessions:
#
#   Test 1 (retrieve): agent is asked to write retry code. Pass = its
#     answer shows it saw the planted double-charge danger zone.
#   Test 2 (capture): agent discovers a wrong assumption. Pass = a real
#     decision record exists in .matha afterwards, written by the agent.
#   Test 3 (memory):  a FRESH session asks what is known about the file.
#     Pass = it repeats the correction from test 2 — memory survived.
#
# Agent behaviour is nondeterministic: a FAIL here means "investigate",
# not "assert". Run it a few times before drawing conclusions.
#
# Usage: scripts/field-test.sh [matha-version]   (default: latest)

set -euo pipefail

VERSION="${1:-latest}"
WORK="$(mktemp -d /tmp/matha-field-XXXX)"
echo "field test workspace: $WORK (matha@$VERSION)"
cd "$WORK"

# ── fixture project with git history and a seeded brain ──────────────
git init -q; git config user.email f@t.io; git config user.name fieldtest
mkdir -p src/payments
cat > src/payments/charge.ts <<'EOF'
export async function charge(orderId: string, amountMinor: number) {
  // calls the payment gateway
}
EOF
git add -A; git commit -qm "initial"

npm init -y >/dev/null 2>&1
npm install --silent "@10kdevs/matha@$VERSION"

mkdir -p .matha/hippocampus/decisions .matha/cerebellum/contracts .matha/cortex
cat > .matha/config.json <<'EOF'
{ "schema_version": "0.2.0" }
EOF
cat > .matha/hippocampus/intent.json <<'EOF'
{ "why": "Demo payment service. Correctness of charging beats everything." }
EOF
cat > .matha/hippocampus/rules.json <<'EOF'
{ "rules": ["A customer is never charged twice for one order"] }
EOF
cat > .matha/hippocampus/danger-zones.json <<'EOF'
{ "zones": [{
  "id": "z-double-charge",
  "component": "src/payments/",
  "pattern": "retry without idempotency key",
  "description": "The gateway acks late under load: any retry that does not reuse the original idempotency key double-charges the customer",
  "confidence": "confirmed"
}] }
EOF

cat > mcp.json <<EOF
{ "mcpServers": { "matha": {
  "command": "node",
  "args": ["$WORK/node_modules/@10kdevs/matha/dist/index.js", "serve", "--project", "$WORK"]
} } }
EOF

# The auto-wire rule from the README, verbatim
cat > CLAUDE.md <<'EOF'
At the start of every conversation, call matha_brief() before writing
any code. Review all rules, danger zones, and prior decisions. Flag any
hasCritical:true results before proceeding. After completing work, call
matha_record() for any assumption that changed during the session.
EOF

run_agent() { # $1 = prompt
  claude -p "$1" \
    --mcp-config mcp.json --strict-mcp-config \
    --allowedTools "mcp__matha,Read,Write,Edit" \
    --max-turns 12 2>/dev/null
}

pass=0; fail=0
verdict() { # $1 = label, $2 = 0/1 success
  if [ "$2" -eq 1 ]; then echo "✓ PASS  $1"; pass=$((pass+1));
  else echo "✗ FAIL  $1"; fail=$((fail+1)); fi
}

# ── Test 1: retrieval — planted danger zone reaches the agent ────────
echo; echo "── Test 1: agent consults the brain before touching payments"
OUT1="$(run_agent 'Add a retry (max 3 attempts) to the charge() call in src/payments/charge.ts. Explain your approach briefly.')"
echo "$OUT1" | tail -5
echo "$OUT1" | grep -qiE "idempoten|double.?charg" \
  && verdict "agent surfaced the planted danger zone" 1 \
  || verdict "agent surfaced the planted danger zone" 0

# ── Test 2: capture — agent writes a decision back ───────────────────
echo; echo "── Test 2: agent records a correction it was told about"
run_agent 'Important project learning you must persist for future sessions: we assumed the payment gateway sandbox behaves like production, but it turns out the sandbox never simulates late acks, so retry bugs only appear in production. Record this in project memory for src/payments/.' >/dev/null
DECISIONS=$(ls .matha/hippocampus/decisions/ 2>/dev/null | wc -l)
[ "$DECISIONS" -ge 1 ] \
  && verdict "decision record written by the agent ($DECISIONS found)" 1 \
  || verdict "decision record written by the agent" 0

# ── Test 3: memory — a FRESH session inherits test 2's learning ──────
echo; echo "── Test 3: new session remembers what the last one learned"
OUT3="$(run_agent 'What does project memory say I should know before changing src/payments/charge.ts? Summarise in 3 bullets.')"
echo "$OUT3" | tail -5
echo "$OUT3" | grep -qiE "sandbox|late ack" \
  && verdict "fresh session repeated the recorded correction" 1 \
  || verdict "fresh session repeated the recorded correction" 0

echo; echo "══ field test: $pass passed, $fail failed — workspace kept at $WORK"
[ "$fail" -eq 0 ]
