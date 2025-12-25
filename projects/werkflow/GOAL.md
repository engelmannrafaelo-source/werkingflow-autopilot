# Projekt: WerkingFlow

## Was ist WerkingFlow

Die zentrale Multi-Tenant B2B2C-Plattform für Ingenieurbüros.
Frontend für alle AI-Workflows (Risikoanalyse, Energieberichte, Gutachten).
**Vision:** "Shopify für Engineering-KI"

## Repository

```
/Users/rafael/Documents/GitHub/werkingflow
```

## Aktueller Stand (17.12.2025)

### Was funktioniert
- Multi-Tenant Auth (NextAuth + Supabase)
- Workflow Engine (9+ Phasen, Railway/Vercel)
- AI-Bridge Integration (Hetzner deployed)
- Presidio DSGVO-Anonymisierung
- Process Chaining (DAG-basiert)
- Wizard System mit Human-in-the-Loop
- Report Generation (Templates, Editor, PDF)
- Teufel-AI Risikoanalyse (4 Phasen) - LIVE
- Energy Report (9 Phasen) - LIVE
- Engelmann Hub Tenant - PRODUKTIV

### Was FEHLT (Gap-Analyse 17.12.2025)
Siehe: `autopilot/reports/gap-analyse-2025-12-17.md`

**Revenue-Blocker:**
- [ ] **Billing/Stripe** - Keine Zahlungsabwicklung
- [ ] **Usage Metering** - Keine Nutzungsverfolgung
- [ ] **Quota Enforcement** - Plan-Limits nicht durchgesetzt

**Partner-Blocker:**
- [ ] **API Key Management** - Kein Self-Service
- [ ] **White-Label UI** - Schema existiert, kein Editor
- [ ] **Developer Portal** - Keine API Docs

---

## Revenue Streams (lt. Businessplan)

| Stream | Status |
|--------|--------|
| Entwicklung (einmalig) | ✅ Manuell |
| Seat-Gebühr €49/User | ❌ FEHLT |
| Workflow-Gebühr 1,5% | ❌ FEHLT |
| API-Kosten 1:1 | ❌ FEHLT |

---

## Erfolgskriterien (MVP → Revenue)

### Phase 1: Revenue Enablement (KRITISCH)
- [ ] Usage Metering Infrastruktur
- [ ] Stripe Billing Integration
- [ ] Quota Enforcement

### Phase 2: Partner Enablement
- [ ] API Key Self-Service
- [ ] White-Label Branding UI
- [ ] Developer Documentation

### Phase 3: Operations
- [ ] Admin Dashboard
- [ ] Email Notifications
- [ ] Audit Logging

### Phase 4: Enterprise
- [ ] SSO (SAML/OIDC)
- [ ] 2FA/MFA
- [ ] Webhook System

---

## Bereits erledigt (Core Platform)
- [x] Multi-Tenant Authentication
- [x] Tenant-Switcher im Header
- [x] AI-Bridge Integration
- [x] Projekt-Verwaltung (CRUD)
- [x] Datei-Upload zu Projekten
- [x] Workflow-Auswahl pro Projekt
- [x] Risikoanalyse-Workflow
- [x] Energiebericht-Workflow
- [x] Report Generation + Templating
- [x] Human-in-the-Loop Review

---

## Constraints

- Next.js 14+ App Router
- TypeScript strict mode
- Tailwind CSS + existierendes Design-System
- Supabase für Auth/DB/Storage
- DSGVO-konform (Presidio PII-Anonymisierung)

## Priorität

**KRITISCH** - Ohne Billing kein Revenue, blockiert Geschäftsmodell
