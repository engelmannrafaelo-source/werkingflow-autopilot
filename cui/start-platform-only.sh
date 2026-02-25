#!/bin/bash
echo "Starting Platform..."
cd /root/projekte/werkingflow/platform && npm run build:local > /tmp/platform-cui-start.log 2>&1 &
echo "Platform starting... check /tmp/platform-cui-start.log"
