# Persona Tagging - Virtual Office Dashboard Integration

**✅ KOMPLETT IMPLEMENTIERT**

---

## 🎯 Was wurde hinzugefügt

### Frontend (React - CommandSidebar.tsx)

**Neue Sektion im "Team" Tab:**
```
🏷️ Persona Tags
├── Beschreibung + Token-Reduktion Info
├── 🚀 Update Persona Tags Button
├── Status-Anzeige (Updating / Success / Error)
└── App-Liste mit Tag-Status (werking-report, engelmann, etc.)
```

**Position:** Zwischen "Team Agenten (16)" und "Weekly Brief"

### Backend (Express - server/index.ts)

**Neue API-Endpoints:**

#### `POST /api/persona-tags/update`
Startet das Update-Script im Hintergrund:
```typescript
// Spawnt: /root/projekte/orchestrator/scripts/update-persona-tags.sh
// Response: { "status": "started" }
```

#### `GET /api/persona-tags/status`
Liefert Status aller Apps:
```typescript
{
  "werking-report": {
    "total_ids": 552,
    "has_tags": true,
    "enriched_mtime": 1708547234,
    "tags_mtime": 1708547456
  },
  "engelmann": { ... },
  // etc.
}
```

---

## 🚀 Wie es funktioniert

### User-Flow:

1. **User öffnet Virtual Office Dashboard**
   ```
   http://localhost:4005  (oder deine URL)
   ```

2. **Klickt im Command Center → Team Tab**
   - Sieht neue Sektion "🏷️ Persona Tags"
   - Zeigt aktuellen Status (z.B. "4/4 apps tagged")

3. **Klickt "🚀 Update Persona Tags"**
   - Button wird disabled
   - Status: "⏳ Updating..."
   - Backend startet Script im Hintergrund

4. **Polling startet automatisch**
   - Alle 5 Sekunden: GET `/api/persona-tags/status`
   - Status-Update: "2/4 apps tagged..."
   - Nach 30s: "✅ Update complete!"

5. **Resultat sichtbar**
   - App-Liste zeigt:
     ```
     werking-report  ✓ 552 IDs
     engelmann       ✓ 487 IDs
     werking-energy  ✓ 234 IDs
     werking-safety     ✓ 189 IDs
     ```

---

## 📁 Geänderte Files

```
/root/projekte/werkingflow/autopilot/cui/
├── src/components/panels/CommandSidebar.tsx    # UPDATED: PersonaTaggingPanel hinzugefügt
├── server/index.ts                              # UPDATED: 2 neue Endpoints
└── PERSONA_TAGGING_INTEGRATION.md               # NEUE Doku

/root/projekte/orchestrator/scripts/
└── update-persona-tags.sh                       # Wird vom Backend aufgerufen
```

---

## 🔧 Server neu starten (notwendig!)

```bash
# 1. CUI Server stoppen
pkill -f "node.*cui.*server"

# 2. TypeScript kompilieren
cd /root/projekte/werkingflow/autopilot/cui
npm run build:server

# 3. Server neu starten
npm run start:server
# oder im Dev-Mode:
npm run dev:server
```

**Nach dem Neustart:**
- Dashboard öffnen: http://localhost:4005
- Command Center → Team Tab
- Sektion "🏷️ Persona Tags" sollte sichtbar sein

---

## 🎨 UI-Design

**Button:**
- Farbe: Purple (`#7c3aed` / `#c4b5fd`)
- State: Disabled während Update
- Text: "🚀 Update Persona Tags" / "⏳ Updating..."

**Status-Box:**
- Info: Purple border-left
- Success: Green (#10b981)
- Error: Red (#ef4444)

**App-Liste:**
- Zeigt: App-Name, ✓/○ Status, Anzahl IDs
- Aktualisiert sich live während Update

---

## ✅ Testing

### 1. Status-Endpoint testen:
```bash
curl http://localhost:4005/api/persona-tags/status | jq
```

**Erwartete Response:**
```json
{
  "werking-report": {
    "total_ids": 552,
    "has_tags": true,
    "enriched_mtime": 1708547234.123,
    "tags_mtime": 1708547456.789
  }
}
```

### 2. Update-Endpoint testen:
```bash
curl -X POST http://localhost:4005/api/persona-tags/update
```

**Erwartete Response:**
```json
{
  "status": "started"
}
```

**Check Logs:**
```bash
# Script läuft im Hintergrund
ps aux | grep update-persona-tags

# Check Output (falls Redirect in Script):
tail -f /tmp/persona-tags-update.log
```

---

## 🐛 Troubleshooting

### Button erscheint nicht
```bash
# 1. Check ob Frontend kompiliert wurde:
cd /root/projekte/werkingflow/autopilot/cui
npm run build

# 2. Check Browser Console:
# Öffne DevTools → Console
# Sollte keine Errors zeigen
```

### API-Endpoints nicht erreichbar
```bash
# 1. Check ob Server läuft:
ps aux | grep "node.*server"

# 2. Check Port:
lsof -i :4005

# 3. Check Server Logs:
# Im Terminal wo Server läuft sollte stehen:
# [Persona Tags] Starting update...
```

### Update startet nicht
```bash
# 1. Check Script existiert:
ls -la /root/projekte/orchestrator/scripts/update-persona-tags.sh

# 2. Check ausführbar:
chmod +x /root/projekte/orchestrator/scripts/update-persona-tags.sh

# 3. Manuell testen:
/root/projekte/orchestrator/scripts/update-persona-tags.sh
```

---

## 🎓 Features

✅ **Live-Status:** Zeigt sofort ob Apps getaggt sind
✅ **Auto-Polling:** Status aktualisiert sich automatisch
✅ **Background-Update:** Blockiert UI nicht
✅ **Multi-App-Support:** Alle 4 Apps werden gleichzeitig getaggt
✅ **Error-Handling:** Zeigt Fehler falls Script failed
✅ **Token-Info:** Zeigt User die Vorteile (68% Reduktion)

---

## 📊 Integration mit Team-Personas

**Nächster Schritt:** Team-Agenten nutzen die gefilterten IDs

**Beispiel (Herbert Security Scan):**
```typescript
// Statt:
const allIds = await loadEnrichedJSON();  // 552 IDs

// Jetzt:
const herbertIds = await fetch('/api/persona-tags/herbert-ids').json();  // 456 IDs
// → 17% Token-Reduktion!
```

**Siehe auch:**
- `/root/projekte/orchestrator/team/PERSONA_TAGGING_INTEGRATION.md`
- `/root/projekte/werkingflow/tests/unified-tester/tools/PERSONA_TAGGING.md`

---

**Status:** ✅ Ready to Deploy
**Nächster Schritt:** CUI Server neu starten
