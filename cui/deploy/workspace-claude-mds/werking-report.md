# WerkING Report — Partner Workspace

## Zweck dieses Workspaces

WerkING Report ist eine KI-gestützte Gutachten-App für technische Sachverständige.
Fokus: Druckbelüftungsanlagen, TRVB-Konformität, strukturierte Gutachtenerstellung.

**Die App läuft auf Port 3008** — erreichbar unter `https://3008.partner.werking.tools/`

---

## Wer nutzt diesen Workspace

### Hans-Peter Kopeinig — Product Owner (Einarbeitung)
DI Montanuniversität, 32 Jahre. Projektleiter bei Kiesverarbeitungsbetrieb (50 MA).
**Sein Ziel:** WerkING Report eigenständig weiterentwickeln — aktuell Selbststudium via Vibe Coding.
**Was er braucht:** App verstehen, Features erkunden, erste eigene Änderungen umsetzen.
Kann Git-Commits und Edits approven.

### Reinhold Bacher — Fachpartner (Anwender)
DI, Sachverständiger für Druckbelüftungsanlagen, Büro Bacher ZT.
~30 Gutachten/Jahr à EUR 1.500. Pionier der TRVB-Idee für die App.
**Sein Ziel:** Gutachten schneller und qualitativ hochwertiger erstellen.
**Was er braucht:** Gutachten anlegen, KI-Analyse nutzen, PDF exportieren.
Kein Code-Zugriff nötig.

---

## Die App — Wie sie funktioniert

**Gutachten-Workflow:**
1. **Login** — `https://partner.werking.tools` → App unter `https://3008.partner.werking.tools/`
2. **Neues Gutachten** — Projekt/Objekt anlegen
3. **Dokumentation** — TipTap-Editor mit strukturierten Abschnitten (TRVB-Vorlage)
4. **KI-Analyse** — Normen-Suche, Gefährdungscheck, Textvorschläge
5. **Export** — PDF-Gutachten generieren

**Architektur:** Next.js 15, React 19, TipTap Editor, Vercel Blob Storage
**Auth:** Standalone JWT (kein Supabase)

---

## App starten

```bash
# App ist bereits gebaut und kann direkt gestartet werden:
cd apps/werking-report
npm run start:local

# Neu bauen (nach Code-Änderungen):
npm run build:local
```

---

## Test-Credentials

| Rolle | Email | Passwort |
|-------|-------|----------|
| Reinhold Bacher (Sachverständiger) | `rb@ztrb.at` | `BacherZT2024!` |
| Test-User | `test@werkingflow.com` | `TestUser2024!` |
| Demo Maria Müller | `maria.mueller@test.at` | `TestUser2024!` |
| Demo Stefan Schneider | `stefan.schneider@test.at` | `TestUser2024!` |

---

## Für Claude: Wie du helfen sollst

**Hans-Peter Kopeinig:** Erkläre Architektur, hilf beim Kennenlernen der Codebasis, unterstütze erste eigene Features.
Hintergrund: Technischer Sachverstand (Ingenieur), aber neu in Web-Entwicklung und Claude Code.
Schritt-für-Schritt erklären, Mut machen zum Ausprobieren.

**Reinhold Bacher:** Hilf bei der Gutachtenerstellung, erkläre wie KI-Features funktionieren, löse Probleme.
Er kennt TRVB-Normen tief — die App erklärt, er entscheidet. Kein Code nötig.

---

## Wichtige Regeln

- **NIEMALS** `pkill -9 next-server` — killt alle Apps
- Ports prüfen: `ss -tlnp | grep 3008`
- Build-System: immer `build:local`, nie `npm run build` direkt
