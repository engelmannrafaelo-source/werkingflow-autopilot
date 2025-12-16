# Projekt: Teufel AI (Risikoanalyse)

## Was ist Teufel AI

Vision-First Risikoanalyse-System für Maschinen-Betriebsanleitungen.
Analysiert PDFs mit Bildern, durchsucht Normen, identifiziert Gefährdungen.

## Repository

```
/Users/rafael/Documents/GitHub/teufel-ai
```

## Aktueller Stand

- Phase 1 (PDF-Analyse mit Vision) implementiert
- Phase 2 (Norm-Suche) implementiert
- Phase 3 (Hazard-Identification) teilweise
- Phase 4 (Report-Generation) ausstehend

## Erfolgskriterien (PoC)

### Phase 1: PDF-Analyse
- [x] PDF → Bilder extrahieren
- [x] Vision API analysiert Safety-Aspekte
- [x] PDF → Markdown Konvertierung
- [x] Maschinen-Daten Extraktion
- [x] Norm-Identifikation

### Phase 2: Norm-Durchsuchung
- [x] Normen als Markdown gecached
- [x] LLM durchsucht gesamte Norm (200K context!)
- [x] Anlagen-spezifische Interpretation

### Phase 3: Gefährdungs-Identifikation
- [x] Gefährdungen generieren
- [ ] Vision-Validierung (Bild-Referenzen)
- [ ] Risk Assessment (S × P × F)
- [ ] Protection Measures

### Phase 4: Report-Generierung
- [ ] Safe Expert JSON Export
- [ ] PDF Report MIT Bildern
- [ ] Executive Summary

## Test Case

**Staurollenförderer** aus `foundation_documents/04_TEST_CASE_Staurollenförderer`

Expected Output:
- ~20 Gefährdungen
- Vision-validiert mit Bild-Referenzen
- Safe Expert kompatibel

## Constraints

- Python 3.11+
- ai-bridge für Claude API
- PyMuPDF für PDF-Verarbeitung
- Vision: Sonnet 4.5
- Text: Haiku 4.5

## Budget

- Pro Analyse: ~€2.20
- Test-Budget: €50 (= 22 Analysen)

## Priorität

**Hoch** - Erste Kundenreferenz (Teufel Ingenieurbüro)
