# Gap-Analyse: Businessplan vs. Architektur
**Datum:** 17. Dezember 2025
**Quelle:** Businessplan NewGmbH/VERTRIEBSUNTERLAGEN + Codebase-Analyse

---

## Executive Summary

| Aspekt | Status |
|--------|--------|
| **Technische Basis** | Solide (Multi-Tenancy, Workflows, AI-Bridge) |
| **Revenue-Readiness** | **BLOCKIERT** - 3/4 Streams nicht implementiert |
| **Partner-Readiness** | **BLOCKIERT** - Keine API Keys, kein White-Label UI |

---

## Was EXISTIERT (Stärken)

### Infrastruktur
- Multi-Tenancy mit RLS, 4 Plan-Tiers (trial/starter/pro/enterprise)
- NextAuth + Supabase Auth
- Workflow Engine (9+ Phasen, Railway/Vercel/Internal)
- Process Chaining (DAG-basiert)
- File Storage (Local/Supabase Dual-Provider)
- RBAC (owner/admin/member/viewer)

### Workflow-System
- Wizard System mit LLM-Assisted Mapping
- Human-in-the-Loop (Review Steps, Interactive Phases)
- Report Generation (CSS/DOCX/HTML/PDF Templates)
- Job Tracking mit Phase-Progress

### AI-Integration
- AI-Bridge (OpenAI-kompatibler Wrapper auf Hetzner)
- Presidio DSGVO-Anonymisierung
- Research Endpoint mit SuperClaude

### Live Workflows
- Energy Report (9 Phasen) - Railway
- Risikoanalyse/Teufel-AI (4 Phasen) - Railway
- EDEdraw Schema Editor

### Tenants
- Engelmann AI Hub produktiv
- Template-Management pro Tenant
- App-Ecosystem (Bacher Hub, EDEdraw)

---

## Was FEHLT (Kritische Gaps)

### PRIORITÄT 1: REVENUE-KRITISCH

#### 1. Billing & Subscription (FEHLT KOMPLETT)
- Keine Stripe/Payment Integration
- Keine Seat-Gebühr Abrechnung (€49/User lt. BP)
- Keine Workflow-Gebühr Tracking (1,5%)
- Keine API-Kosten Durchreichung
- Keine Invoices
- `stripeCustomerId` existiert im Schema, aber ungenutzt

**Impact:** BLOCKIERT GESAMTES GESCHÄFTSMODELL

#### 2. Usage Metering (FEHLT KOMPLETT)
- Keine API-Call Zählung
- Keine Workflow-Execution Tracking
- Keine Storage-Nutzung Metering
- Keine Seat-Count Tracking
- Keine Cost Attribution

**Impact:** Kann nicht usage-basiert abrechnen

#### 3. Quota Enforcement (SCHEMA EXISTIERT, NICHT ENFORCED)
- `maxProjects`, `maxStorageGB`, `maxUsersPerTenant` in DB
- Aber KEINE Checks bei Upload/Create
- Plan-Tiers haben keine Wirkung

**Impact:** Features versprochen aber nicht durchgesetzt

---

### PRIORITÄT 2: PARTNER-KRITISCH

#### 4. API Key Management (FEHLT)
- Keine Key Generation
- Keine Rotation
- Kein Scope/Permission System
- Kein Rate Limiting per Key

#### 5. White-Label (SCHEMA EXISTIERT, KEIN UI)
- Branding-Felder in TenantSettings vorhanden
- Aber: Kein Custom Domain, CSS Injection, Email Templates
- Kein Branding Editor

#### 6. Developer Portal (FEHLT)
- Keine API Docs UI
- Keine SDK Downloads
- Kein Onboarding Wizard

---

### PRIORITÄT 3: OPERATIONS

#### 7. Admin Dashboard (FEHLT)
- Keine Platform Admin Console
- Keine Tenant-Verwaltung UI
- Keine Usage Analytics

#### 8. Notifications (FEHLT)
- Keine Email Notifications
- Keine In-App Alerts
- Keine SMTP per Tenant

#### 9. Audit Logging (TABELLEN EXISTIEREN, NICHT BEFÜLLT)

---

### PRIORITÄT 4: ENTERPRISE

- SSO (SAML/OIDC) - Geplant, nicht implementiert
- 2FA/MFA - Fehlt
- Webhooks - Nur interne Callbacks

---

## Revenue Streams (Businessplan)

| Stream | Beschreibung | Status |
|--------|--------------|--------|
| Entwicklungshonorare | Einmalig, manuell | ✅ OK (extern) |
| Seat-Gebühr €49/User | Monatlich | ❌ FEHLT |
| Workflow-Gebühr 1,5% | Monatlich | ❌ FEHLT |
| API-Kosten 1:1 | Per Use | ❌ FEHLT |

---

## Empfohlene Roadmap

### Phase 1: Revenue Enablement
1. Usage Metering Infrastruktur
2. Stripe Billing Integration
3. Quota Enforcement

### Phase 2: Partner Enablement
4. API Key Self-Service
5. White-Label UI
6. Developer Docs

### Phase 3: Operations
7. Admin Dashboard
8. Email Notifications
9. Audit Logging

### Phase 4: Enterprise
10. SSO
11. 2FA
12. Webhooks

---

## Kritische Dateien

- `platform/src/types/tenant.ts` - Plan Definitions (Limits nicht enforced)
- `platform/src/services/` - Core Services (6300+ Zeilen)
- `platform/supabase/migrations/` - DB Schema
- `bridge/src/tenant/usage_tracker.py` - Usage Tracking (nur Bridge-seitig)

---

*Generiert durch Gap-Analyse Session*
