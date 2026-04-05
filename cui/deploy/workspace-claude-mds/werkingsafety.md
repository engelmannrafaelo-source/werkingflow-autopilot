# WerkING Safety — Partner Workspace

## Zweck dieses Workspaces

WerkING Safety ist eine KI-gestützte Risikoanalyse-App für technische Anlagen.
Kern: PDF-Pläne hochladen → KI analysiert → strukturierte Gefährdungsbeurteilung + PAAG/HAZOP-Export.

**Die App läuft auf Port 3006** — im Browser-Panel: `/app-proxy/3006`

---

## Wer nutzt diesen Workspace

### Herbert Teufel — Fachpartner (Anwender + Reviewer)
DI, PhD. Geschäftsführer TECC (ZT für Automatisierte Anlagen- und Prozesstechnik).
20% Profit-Share WerkING Safety, 20% Sales-Provision. Exklusiver Premium-Prüfer (12 Monate).
**EUR 21.000 Gesamtinvestition** (Phase 1 + Förderung + Partnerinvestition).

**Sein Ziel:** Risikoanalysen für seine Kunden (automatisierte Anlagen) schneller und normenkonform erstellen.
**Was er braucht:** Projekte anlegen, PDFs analysieren, Gefährdungen prüfen, Safe Expert Export.

---

## Die App — Wie sie funktioniert

**Analyse-Workflow:**
1. **Login** — `https://partner.werking.tools` → `/app-proxy/3006`
2. **Projekt anlegen** — Anlage, Kunde, Norm-Framework wählen
3. **Dokumente hochladen** — P&ID-Pläne, Verfahrensbeschreibungen als PDF
4. **KI-Analyse** — Vision-basierte Erkennung: Equipment, Gefahrenstellen, Prozessparameter
5. **Norm-Suche (RAG)** — KI durchsucht Normen (IEC 61508, IEC 62061, EN ISO 13849 etc.)
6. **PAAG/HAZOP** — Strukturierte Gefährdungsbeurteilung, Maßnahmen-Vorschläge
7. **Safe Expert Export** — Export im Safe Expert Format

**Architektur:** Next.js Frontend, FastAPI Backend (Port 8765), RAG-Normdatenbank
**Auth:** Standalone JWT, Single-Tenant (Herbert Teufel ist Admin)

---

## App starten

```bash
# App ist bereits gebaut und kann direkt gestartet werden:
cd apps/werking-safety
npm run start:local

# Neu bauen (nach Code-Änderungen):
npm run build:local
```

---

## Test-Credentials

| Rolle | Email | Passwort |
|-------|-------|----------|
| Herbert Teufel (Admin) | `herbert@teufel.at` | `TestUser2024!` |

**Hinweis:** WerkING Safety ist Single-Tenant — Herbert Teufel ist der einzige Nutzer.
Admin-Account wird beim ersten Start aus den Env-Vars erstellt.

---

## Für Claude: Wie du helfen sollst

**Herbert Teufel:** Experte für automatisierte Anlagen, kennt Normen tief (IEC 61508 etc.).
Er braucht keine Einführung in Sicherheitstechnik — er weiß was er tut.
Hilf bei: App-Navigation, Analyse-Ergebnisse interpretieren, Export-Probleme lösen.
Bei technischen Fragen zur App: konkret und direkt antworten.
Bei Norm-Fragen: Er ist der Experte — nur unterstützen, nicht belehren.

---

## Wichtige Regeln

- **NIEMALS** `pkill -9 next-server` — killt alle Apps
- Ports prüfen: `ss -tlnp | grep 3006`
- Backend auf Port 8765 — läuft separat
- Build-System: immer `build:local`, nie `npm run build` direkt
