#!/bin/bash
set -e

# Model tier: haiku | sonnet | opus (default: sonnet)
# Usage: pnpm dev [model]   or   ROVER_MODEL=haiku pnpm dev
export ROVER_MODEL="${ROVER_MODEL:-${1:-sonnet}}"

case "$ROVER_MODEL" in
  haiku|sonnet|opus) ;;
  *)
    echo "Unknown model \"$ROVER_MODEL\" — use haiku, sonnet, or opus."
    exit 1
    ;;
esac

echo "🚀 Starting Mars Rover Agent..."
echo ""
echo "Agent model → $ROVER_MODEL"
echo "Mission (agent loop) → WS telemetry on ws://localhost:3001"
echo "Viewer → http://localhost:5173"
echo ""
echo "Press Ctrl+C to stop both servers."
echo ""

# Start mission in background
pnpm --filter @mars/server mission &
MISSION_PID=$!

# Give the mission a moment to start
sleep 1

# Start viewer in background
pnpm --filter @mars/client dev &
VIEWER_PID=$!

# Trap Ctrl+C to kill both
trap "echo ''; echo '⏹️  Shutting down...'; kill $MISSION_PID $VIEWER_PID 2>/dev/null; exit 0" INT

# Wait for both
wait
