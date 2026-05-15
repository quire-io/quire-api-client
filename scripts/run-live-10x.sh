#!/usr/bin/env bash
#
# Run the live API suite N times sequentially with a cool-down between runs.
# Purpose: surface flakiness AND rate-limit pressure across many runs without
# bursting Quire's per-minute/per-hour quotas.
#
# Usage:
#   scripts/run-live-10x.sh                  # 10 runs, 60s gap
#   scripts/run-live-10x.sh 5                # 5 runs, 60s gap
#   GAP=120 scripts/run-live-10x.sh 10       # 10 runs, 120s gap
#   FILTER='task.live' scripts/run-live-10x.sh  # restrict to matching files
#
# Output:
#   /tmp/quire-live-runs-<timestamp>/run-N.log   # full vitest output per run
#   /tmp/quire-live-runs-<timestamp>/summary.txt # pass/fail + 429 count table
#
# Why a cool-down? helpers.ts already retries 429s in-band with exponential
# backoff (60s cap), but Quire's hourly quota is per-token, not per-request,
# so back-to-back full-suite runs can exhaust it. A 60s gap is a starting
# point — bump it via GAP= if you see 429s climbing across runs.

set -u

RUNS="${1:-10}"
GAP="${GAP:-60}"
FILTER="${FILTER:-}"
TS="$(date +%Y%m%d-%H%M%S)"
LOGDIR="/tmp/quire-live-runs-${TS}"

mkdir -p "$LOGDIR"

VITEST_CMD=(npx vitest run --project live)
if [ -n "$FILTER" ]; then
  # Vitest's positional args filter test files by substring match. Useful for
  # smoke-running a single resource 10x without paying for the whole suite.
  VITEST_CMD+=("$FILTER")
fi

echo "Live suite: $RUNS runs, ${GAP}s gap, logs → $LOGDIR"
echo "Command:   ${VITEST_CMD[*]}"
echo

SUMMARY="$LOGDIR/summary.txt"
printf "%-6s %-6s %-10s %-12s %s\n" "run" "status" "duration" "429-retries" "tests-failed" > "$SUMMARY"

for i in $(seq 1 "$RUNS"); do
  LOG="$LOGDIR/run-${i}.log"
  START="$(date +%s)"
  echo "=== Run $i/$RUNS — $(date) ==="

  if "${VITEST_CMD[@]}" > "$LOG" 2>&1; then
    STATUS="pass"
  else
    STATUS="FAIL"
  fi

  END="$(date +%s)"
  DUR=$((END - START))

  # `[429] METHOD /path retry-after=…` lines are emitted by helpers.ts's
  # rawApi backoff. Each line = one retry; rising counts across runs is the
  # leading indicator that we're approaching Quire's hourly cap.
  # `; true` so the subshell exits 0 even when grep -c finds zero matches
  # (which would otherwise return exit 1 and trip `set -e`-style callers).
  C429="$(grep -c '\[429\]' "$LOG" 2>/dev/null; true)"
  # Vitest prints "Tests  N failed | M passed" — grab the "Tests" line
  # specifically so we don't pick up the "Test Files N failed" total.
  CFAIL="$(grep -E '^[[:space:]]*Tests[[:space:]]' "$LOG" 2>/dev/null | grep -oE '[0-9]+ failed' | head -1 | grep -oE '^[0-9]+'; true)"
  [ -z "$CFAIL" ] && CFAIL=0

  echo "  status=$STATUS  duration=${DUR}s  429-retries=$C429  tests-failed=$CFAIL"
  printf "%-6s %-6s %-10s %-12s %s\n" "$i" "$STATUS" "${DUR}s" "$C429" "$CFAIL" >> "$SUMMARY"

  if [ "$i" -lt "$RUNS" ]; then
    echo "  sleeping ${GAP}s before next run…"
    sleep "$GAP"
  fi
done

echo
echo "=== Summary ==="
cat "$SUMMARY"
echo
echo "Per-run logs: $LOGDIR"
