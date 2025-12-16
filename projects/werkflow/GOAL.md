# Projekt: WerkingFlow

## Was ist WerkingFlow

Die zentrale Multi-Tenant Plattform für Ingenieurbüros.
Frontend für alle AI-Workflows (Risikoanalyse, Energieberichte, Gutachten).

## Repository

```
/Users/rafael/Documents/GitHub/werkflow
```

## Aktueller Stand

- Multi-Tenant Auth funktioniert
- AI-Bridge Integration vorhanden
- Billing Dashboard implementiert
- Settings-Bereich teilweise

## Erfolgskriterien (MVP)

### Core Platform
- [x] Multi-Tenant Authentication
- [x] Tenant-Switcher im Header
- [x] AI-Bridge Integration mit Tenant-Headers
- [x] Billing Dashboard (AI-Nutzung)
- [ ] Projekt-Verwaltung (CRUD)
- [ ] Datei-Upload zu Projekten
- [ ] Workflow-Auswahl pro Projekt

### Workflows
- [ ] Risikoanalyse-Workflow (teufel-ai Integration)
- [ ] Energiebericht-Workflow (energy-report Integration)
- [ ] Gutachten-Workflow (engelmann Integration)

### Admin
- [x] Settings-Übersicht
- [x] Billing/AI-Nutzung
- [ ] Team-Verwaltung
- [ ] API-Key Management

## Constraints

- Next.js 14+ App Router
- TypeScript strict mode
- Tailwind CSS + existierendes Design-System
- Supabase für Auth/DB/Storage
- DSGVO-konform (Privacy-First)

## Offene Fragen

- Wie sollen Workflows dynamisch registriert werden?
- Welches Pricing-Modell für Tenants?

## Priorität

**Hoch** - Zentrale Plattform für alle anderen Projekte
