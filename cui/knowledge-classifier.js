// AI-based Document Classification via Bridge
// Created: 2026-02-19
const BRIDGE_URL = process.env.AI_BRIDGE_URL || 'http://49.12.72.66:8000';
const BRIDGE_KEY = process.env.AI_BRIDGE_API_KEY;
if (!BRIDGE_KEY) {
    console.warn('[Classifier] Warning: AI_BRIDGE_API_KEY not set, classification will fail');
}
export async function classifyDocument(req) {
    const systemPrompt = buildClassificationSystemPrompt();
    const userPrompt = buildClassificationUserPrompt(req);
    try {
        const response = await fetch(`${BRIDGE_URL}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${BRIDGE_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-5-20250929',
                temperature: 0.3, // Consistent classifications
                max_tokens: 2000,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
            }),
        });
        if (!response.ok) {
            throw new Error(`Bridge classification failed: ${response.statusText}`);
        }
        const data = await response.json();
        const content = data.choices[0].message.content;
        return parseClassificationResponse(content);
    }
    catch (err) {
        console.error(`[Classifier] Error classifying ${req.document_path}:`, err.message);
        throw err;
    }
}
export async function batchClassifyDocuments(documents, personas) {
    const results = {};
    const BATCH_SIZE = 10;
    for (let i = 0; i < documents.length; i += BATCH_SIZE) {
        const batch = documents.slice(i, i + BATCH_SIZE);
        console.log(`[Classifier] Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(documents.length / BATCH_SIZE)}`);
        const promises = batch.map((doc) => classifyDocument({
            document_path: doc.path,
            document_summary: doc.summary,
            filename: doc.filename,
            category: doc.category,
            available_personas: personas,
        })
            .then((result) => ({ path: doc.path, result }))
            .catch((err) => {
            console.error(`[Classifier] Failed to classify ${doc.path}:`, err.message);
            return { path: doc.path, result: null };
        }));
        const batchResults = await Promise.all(promises);
        for (const { path, result } of batchResults) {
            if (result)
                results[path] = result;
        }
        // Rate limiting: 1s pause between batches
        if (i + BATCH_SIZE < documents.length) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }
    return results;
}
function buildClassificationSystemPrompt() {
    return `Du bist ein intelligenter Dokumenten-Klassifikator für ein Business-Dokumenten-System.

Deine Aufgabe:
1. Analysiere das Dokument (Pfad, Kategorie, Inhalt-Summary)
2. Ordne es den relevanten Personas zu basierend auf deren Expertise
3. Bewerte Confidence-Score (0-100) und Relevanz (primary/secondary/tangential)
4. Extrahiere Dokument-Typ und Topics

Confidence-Score Guidelines:
- 90-100: Perfekte Übereinstimmung (z.B. Marketing-Doc → Mira Marketing)
- 70-89: Starke Übereinstimmung (Department-Match)
- 50-69: Moderate Übereinstimmung (Secondary Interest)
- 30-49: Schwache Übereinstimmung (Tangential)
- 0-29: Keine Zuweisung (nicht zurückgeben)

Relevanz Guidelines:
- primary: Kernverantwortung der Persona (z.B. campaigns.md → Mira)
- secondary: Indirekte Relevanz (z.B. campaigns.md → Vera für Lead-Context)
- tangential: Randinteresse (z.B. campaigns.md → Felix für Innovation-Ideas)

Antworte IMMER mit validem JSON in diesem Format:
{
  "assignments": [
    {
      "persona_id": "mira",
      "confidence": 95,
      "reason": "Marketing Lead - Kampagnen sind Kernverantwortung",
      "relevance": "primary"
    }
  ],
  "document_type": "marketing-campaign",
  "topics": ["lead-generation", "post-event", "conversion"],
  "summary": "Marketing-Kampagnen mit Fokus auf Post-Event Conversion"
}

WICHTIG:
- Filtere Assignments mit Confidence < 30 raus
- Max 200 Zeichen für summary
- Topics als lowercase Keywords
- Nur Personas zuweisen wenn relevanter Match`;
}
function buildClassificationUserPrompt(req) {
    let prompt = `# Dokument zu klassifizieren

**Pfad:** ${req.document_path}
**Dateiname:** ${req.filename}
**Kategorie:** ${req.category}

**Inhalt (Summary):**
${req.document_summary}

---

# Verfügbare Personas

`;
    for (const persona of req.available_personas) {
        prompt += `## ${persona.name} (${persona.id})
**Rolle:** ${persona.role}
**Department:** ${persona.department}
**Expertise:** ${persona.expertise_keywords.join(', ')}
**Primary Paths:** ${persona.primary_paths.slice(0, 3).join(', ')}
**Beschreibung:** ${persona.description.slice(0, 150)}

`;
    }
    prompt += `\nAnalysiere das Dokument und ordne es den relevanten Personas zu. Antworte mit JSON.`;
    return prompt;
}
function parseClassificationResponse(content) {
    // Extract JSON from markdown code blocks if present
    const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/) || content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        throw new Error('No JSON found in classification response');
    }
    const jsonStr = jsonMatch[1] || jsonMatch[0];
    const parsed = JSON.parse(jsonStr);
    // Validation
    if (!parsed.assignments || !Array.isArray(parsed.assignments)) {
        throw new Error('Invalid classification response: missing assignments array');
    }
    // Filter out low-confidence assignments
    parsed.assignments = parsed.assignments.filter((a) => a.confidence >= 30);
    // Ensure summary is max 200 chars
    if (parsed.summary && parsed.summary.length > 200) {
        parsed.summary = parsed.summary.slice(0, 197) + '...';
    }
    return parsed;
}
