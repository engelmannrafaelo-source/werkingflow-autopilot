# Rafael's Development Context

> Dieser Kontext wird automatisch aus den definierten Quellen (sources/SOURCES.md) aktualisiert.
> Letzte Aktualisierung: [wird automatisch gesetzt]

---

## Wer bin ich

- Solo-Entwickler/Gründer
- Fokus: B2B SaaS für Engineering-Firmen
- Hauptkunden: Ingenieurbüros (Bacher ZT, Teufel, Engelmann)

## Mein Business

- **WerkingFlow**: Zentrale Multi-Tenant Plattform für Ingenieurbüros
- **Ziel**: AI-gestützte Workflows für technische Dokumentation
- **Markt**: DACH-Region, deutschsprachige Ingenieure

## Mein Tech-Stack

### Frontend
- Next.js 14+ (App Router)
- TypeScript (strict mode)
- Tailwind CSS
- Shadcn/UI Komponenten

### Backend
- Supabase (Auth, DB, Storage)
- Railway (Workflow-Backends)
- PostgreSQL

### AI
- Claude via ai-bridge (Hetzner)
- Presidio für DSGVO-Anonymisierung
- Privacy Modes: none | basic | full

### Patterns
- Multi-Tenancy by default
- Workflow-Engine
- Report-Generation (PDF, DOCX)
- Defensive Programming (fail loud, not silent)

## Meine Repositories

| Repository | Zweck | Status |
|------------|-------|--------|
| **werkflow** | Zentrale Plattform (Multi-Tenant) | Aktiv |
| **ai-bridge** | OpenAI-kompatibles Gateway für Claude | Aktiv |
| **teufel-ai** | Risikoanalyse-Workflow | PoC |
| **ededraw** | CAD/Schema Editor | Aktiv |
| **engelmann-ai-hub** | Gutachten-System | Wartung |

## Wie sie zusammenhängen

```
werkflow (Frontend)
    │
    ├── ai-bridge (AI Gateway) ──→ Claude API
    │       └── Presidio (Anonymisierung)
    │
    ├── Railway Backends
    │   ├── teufel-ai (Risikoanalyse)
    │   └── energy-report (Energieberichte)
    │
    └── Supabase
        ├── Auth (Multi-Tenant)
        ├── Database (PostgreSQL)
        └── Storage (Dokumente)
```

## Meine Qualitätsstandards

1. **TypeScript strict mode** - Keine `any` Types
2. **Defensive Programming** - Fail loud, never silent
3. **DSGVO-konform** - Privacy-First Architecture
4. **Multi-Tenant** - Jedes Feature tenant-aware
5. **Tests** - E2E für kritische Pfade

## Aktuelle Prioritäten

> Dieser Abschnitt wird aus Emails/Coach automatisch aktualisiert

1. WerkingFlow als zentrale Plattform etablieren
2. Teufel Risikoanalyse-PoC abschließen
3. Engelmann-Migration zu WerkingFlow

## Offene Entscheidungen

> Dieser Abschnitt sammelt Entscheidungen die noch getroffen werden müssen

- [ ] Railway vs Vercel für Workflow-Backends
- [ ] Pricing-Modell für Multi-Tenant

---

## Quellen-Metadaten

```yaml
# Wird automatisch befüllt
last_updated: null
sources_used:
  - type: manual
    file: CONTEXT.md
update_log: []
```
