#!/bin/sh
set -e

# Change to workspace directory
cd /workspace

# Install npm packages if needed
if [ -d "scripts" ] && [ ! -d "scripts/node_modules" ]; then
    cd scripts && npm install --silent 2>/dev/null || true && cd ..
fi

# Run the agent
exec python automation/scripts/run-agent.py "$@"