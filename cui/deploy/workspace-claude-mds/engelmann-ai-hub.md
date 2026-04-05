# Engelmann AI Hub — Partner Workspace

## Zweck dieses Workspaces

Der Engelmann AI Hub ist ein KI-Workflow-Cockpit für Engelmann Energiesysteme GmbH.
Kunden von Engelmann bekommen damit KI-gestützte Energieanalyse-Workflows — ohne selbst zu coden.

**Die App läuft auf Port 3009** — im Browser-Panel: `/app-proxy/3009`

---

## Wer nutzt diesen Workspace

### David Engelmann — Entwicklungspartner (technisch)
Inhaber Engelmann Energiesysteme GmbH. EUR 25.000 Entwicklungspartnerschaft (10k 2025 + 15k 2026).
**Sein Ziel:** Eigene KI-Workflows für seine Kunden bauen und über den Hub anbieten.
**Was er braucht:** Workflows entwickeln/testen, App verstehen, Feedback geben.
Hat volle App-Zugriffsrechte als Owner.

### Kurt Engelmann — Mitarbeiter (Anwender)
Mitarbeiter bei Engelmann Energiesysteme. Nutzt den Hub für Kundenprojekte.
**Sein Ziel:** Fertige Workflows bedienen, Ergebnisse für Kunden aufbereiten.
**Was er braucht:** Workflows starten, Ergebnisse lesen, Export.

### Sahori Nakamura — Workflow-Entwicklerin
Mitarbeiterin bei Engelmann, entwickelt Workflows mit Claude Code.
Login: `sahori@engelmann-es.at` — falls sie sich bei dir meldet.

---

## Die App — Wie sie funktioniert

**Workflow-Cockpit:**
1. **Login** — `https://partner.werking.tools` → `/app-proxy/3009`
2. **Workflow auswählen** — aus Bibliothek vordefinierter Energieanalyse-Workflows
3. **Input hochladen** — Kundendaten, Messdaten, PDFs
4. **Workflow ausführen** — KI-Pipeline mit konfigurierbaren Schritten
5. **Ergebnis** — Analysen, Berichte, Handlungsempfehlungen

**Architektur:** Next.js 15, React 19, Supabase (Auth + DB), TipTap Editor
**Besonderheit:** Workflows sind frei programmierbar (YAML + Custom React)

---

## App starten

```bash
# App ist bereits gebaut (build:live — braucht Supabase):
cd apps/engelmann
npm run start:live

# Neu bauen:
npm run build:live
```

**Hinweis:** Engelmann nutzt `build:live` (Supabase Production) — kein lokaler Docker nötig.

---

## Test-Credentials

| Rolle | Email | Passwort |
|-------|-------|----------|
| David Engelmann (Owner) | `david@engelmann.at` | `Engelmann2024!` |
| Kurt Engelmann (Mitarbeiter) | `mitarbeiter@engelmann-es.at` | `EngelmannTeam2024!` |
| Sahori Nakamura (Dev) | `sahori@engelmann-es.at` | `EngelmannDev2024!` |
| Thomas Berger (Test) | `thomas@werkingflow.com` | `ThomasBerger2024!` |

---

## Für Claude: Wie du helfen sollst

**David Engelmann:** Unternehmer, kein tiefer Tech-Background aber versteht KI-Konzepte.
Hilf bei: Workflow-Ideen umsetzen, App-Features verstehen, Business-Anforderungen in Workflows übersetzen.
Ton: unternehmerisch, pragmatisch, auf Ergebnisse fokussiert.

**Kurt Engelmann:** Anwender, kein Technik-Hintergrund nötig.
Hilf bei: Bedienung, Probleme lösen, Ergebnisse verstehen.
Ton: einfach, konkret, Schritt-für-Schritt.

---

## Wichtige Regeln

- **NIEMALS** `pkill -9 next-server` — killt alle Apps
- Ports prüfen: `ss -tlnp | grep 3009`
- Engelmann braucht `build:live` (Supabase) — `build:local` funktioniert nicht
- Build-System: immer `build:live`, nie `npm run build` direkt
