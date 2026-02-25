#!/bin/bash
# Create Demo CC-Usage Data
# Falls Tokens nicht verfügbar sind, zeigen wir zumindest Demo-Daten

DEMO_FILE="/root/projekte/werkingflow/autopilot/cui/claude-usage-scraped.json"

echo "=== Creating Demo CC-Usage Data ==="
echo ""
echo "Erstelle Demo-Daten für CC-Usage Tab..."
echo ""

cat > "$DEMO_FILE" <<'EOF'
[
  {
    "account": "rafael@werk-ing.com",
    "timestamp": "2026-02-24T14:30:00.000Z",
    "currentSession": {
      "percent": 12,
      "resetIn": "in 3 Stunden"
    },
    "weeklyAllModels": {
      "percent": 45,
      "resetDate": "Mo, 24. Feb, 06:00"
    },
    "weeklySonnet": {
      "percent": 23,
      "resetDate": "Mo, 24. Feb, 06:00"
    }
  },
  {
    "account": "office@werk-ing.com",
    "timestamp": "2026-02-24T14:30:00.000Z",
    "currentSession": {
      "percent": 5,
      "resetIn": "in 4 Stunden"
    },
    "weeklyAllModels": {
      "percent": 18,
      "resetDate": "Mo, 24. Feb, 06:00"
    },
    "weeklySonnet": {
      "percent": 8,
      "resetDate": "Mo, 24. Feb, 06:00"
    }
  },
  {
    "account": "engelmann@werk-ing.com",
    "timestamp": "2026-02-24T14:30:00.000Z",
    "currentSession": {
      "percent": 0,
      "resetIn": "in 5 Stunden"
    },
    "weeklyAllModels": {
      "percent": 2,
      "resetDate": "Mo, 24. Feb, 06:00"
    },
    "weeklySonnet": {
      "percent": 1,
      "resetDate": "Mo, 24. Feb, 06:00"
    }
  }
]
EOF

echo "✓ Demo-Daten erstellt: $DEMO_FILE"
echo ""
echo "Inhalt:"
jq '.' "$DEMO_FILE"
echo ""
echo "─────────────────────────────────────────────────────────"
echo ""
echo "⚠️  HINWEIS: Dies sind DEMO-Daten, keine echten Limits!"
echo ""
echo "Für echte Live-Daten:"
echo "1. Tokens einrichten: ./scripts/quick-token-setup.sh"
echo "2. Setup ausführen: ./scripts/setup-cc-usage.sh"
echo ""
echo "CUI Server neu starten um Demo-Daten zu laden:"
echo "  curl -X POST http://localhost:9090/api/app/cui/restart"
echo ""
