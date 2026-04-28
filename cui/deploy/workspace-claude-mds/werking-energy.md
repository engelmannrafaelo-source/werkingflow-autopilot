# WerkING Energy — Partner Workspace

## Zweck dieses Workspaces

WerkING Energy erstellt automatisierte Energieoptimierungsberichte für Gebäude und Anlagen.
Der Kern: Messdaten rein → KI-Pipeline → professioneller Bericht raus (30–40 Minuten).

**Die App läuft auf Port 3007** — erreichbar unter `https://3007.partner.werking.tools/`

---

## Wer nutzt diesen Workspace

### David Steiner (vormals Wimmesberger) — Product Owner (Entwicklung)
Mathematiker, 10 Jahre Energieoptimierung (DAGOPT GmbH). Aktuell in Karenz.
**Sein Ziel:** WerkING Energy eigenständig weiterentwickeln via Vibe Coding.
**Was er braucht:** Feature-Entwicklung, Code-Verständnis, Architektur-Entscheidungen.
Kann Git-Commits und Edits approven.

### Markus Plasser — Fachpartner (Anwender)
Inhaber ReFit Energy GmbH, 20+ Jahre HLK/Optimierung. Fachpartner mit 20% Profit-Share.
**Sein Ziel:** Die App für seine Kunden (DB Keiner, Heimbau etc.) produktiv einsetzen.
**Was er braucht:** Berichte erstellen, Messdaten verarbeiten, Ergebnisse interpretieren.
Kein Code-Zugriff nötig.

---

## Die App — Wie sie funktioniert

**5-Schritt-Wizard** zum Erstellen eines Berichts:
1. **Projekt anlegen** — Name, Gebäude, Kundendaten
2. **Messdaten hochladen** — CSV/Excel mit Energiemesswerten
3. **Parameter konfigurieren** — Analysezeitraum, Benchmarks
4. **Pipeline starten** — 9 Phasen, läuft 30–40 Minuten
5. **Bericht herunterladen** — PDF mit KI-Analyse und Handlungsempfehlungen

**Backend:** FastAPI auf Port 8030 (läuft parallel)
**Architektur:** Next.js Frontend + Python Backend + KI-Analyse via AI-Bridge

---

## App starten

```bash
# App ist bereits gebaut und kann direkt gestartet werden:
cd apps/werking-energy
npm run start:local

# Neu bauen (nach Code-Änderungen):
npm run build:local
```

---

## Test-Credentials

| Rolle | Email | Passwort |
|-------|-------|----------|
| Markus Plasser (Fachpartner) | `markus.plasser@icloud.com` | `Plasser2026!` |
| Demo-User | `demo@werkingflow.com` | `DemoUser2024!` |
| Test-User | `test@werkingflow.com` | `TestUser2024!` |

---

## Für Claude: Wie du helfen sollst

**David Wimmesberger:** Erkläre Architektur, hilf bei Feature-Entwicklung, schreib und ändere Code.
Hintergrund: Mathematiker mit Energiefachkenntnissen, lernt gerade Claude Code + Vibe Coding.
Erkläre technische Entscheidungen klar, er versteht Konzepte schnell.

**Markus Plasser:** Hilf bei der App-Bedienung, erkläre Ergebnisse, löse Probleme beim Erstellen von Berichten.
Kein Code — er braucht keine technischen Erklärungen, sondern praktische Unterstützung.

---

## Wichtige Regeln

- **NIEMALS** `pkill -9 next-server` — killt alle Apps gleichzeitig
- Ports prüfen: `ss -tlnp | grep 3007`
- Build-System: immer `build:local` oder `build:live`, nie `npm run build` direkt
