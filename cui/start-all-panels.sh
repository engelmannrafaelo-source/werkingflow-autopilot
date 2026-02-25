#!/bin/bash
# Start All Panels - Detached Background Processes

echo "Starting all missing panels..."

# Platform
if ! lsof -ti:3004 >/dev/null 2>&1; then
  echo "Starting Platform (port 3004)..."
  cd /root/projekte/werkingflow/platform && nohup npm run build:local > /tmp/platform-autostart.log 2>&1 &
fi

# Dashboard
if ! lsof -ti:3333 >/dev/null 2>&1; then
  echo "Starting Dashboard (port 3333)..."
  cd /root/projekte/werkingflow/dashboard && nohup python3 -m dashboard.app > /tmp/dashboard-autostart.log 2>&1 &
fi

# Werking-Report
if ! lsof -ti:3008 >/dev/null 2>&1; then
  echo "Starting Werking-Report (port 3008)..."
  cd /root/projekte/werking-report && nohup npm run build:local > /tmp/werking-report-autostart.log 2>&1 &
fi

# Werking-Energy
if ! lsof -ti:3007 >/dev/null 2>&1; then
  echo "Starting Werking-Energy (port 3007)..."
  cd /root/projekte/apps/werking-energy && nohup npm run build:local > /tmp/werking-energy-autostart.log 2>&1 &
fi

# Engelmann
if ! lsof -ti:3009 >/dev/null 2>&1; then
  echo "Starting Engelmann (port 3009)..."
  cd /root/projekte/engelmann-ai-hub && nohup npm run build:local > /tmp/engelmann-autostart.log 2>&1 &
fi

# TECC-Safety
if ! lsof -ti:3005 >/dev/null 2>&1; then
  echo "Starting TECC-Safety (port 3005)..."
  cd /root/projekte/werking-safety/frontend && nohup npm run build:local > /tmp/tecc-safety-autostart.log 2>&1 &
fi

echo "Done! Panels are starting in background."
echo "Check logs in /tmp/*-autostart.log"
