// Cloudflare Pages Function — POST /analyze
// Receives the client-side aggregated CRM data (counts already computed in
// the browser) and asks Claude to synthesize the qualitative parts
// (general impression, recurring themes, benchmark commentary, barriers)
// per product category. The API key never reaches the browser: it lives
// only as a Cloudflare Pages secret (ANTHROPIC_API_KEY).

const CATEGORY_KEYS = ['screens', 'shutters', 'awnings', 'pergola'];

// Forces Claude to return exactly this shape via tool-use, so the frontend
// never has to guess-parse free-form text.
const ANALYSIS_TOOL = {
  name: 'submit_analysis',
  description: 'Structured feedbackloop analysis per product category.',
  input_schema: {
    type: 'object',
    properties: Object.fromEntries(CATEGORY_KEYS.map((cat) => [cat, {
      type: 'object',
      properties: {
        existing_customers: {
          type: 'object',
          properties: {
            general_impression: { type: 'string', description: 'Narrative summary (NL) of how existing customers experience the product, positive and negative.' },
            themes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  count: { type: 'integer', description: 'How many remarks reflect this viewpoint.' },
                  sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
                },
                required: ['label', 'count', 'sentiment'],
              },
            },
            benchmark_product: { type: 'string', description: 'What customers say about specs/offering vs competitors.' },
            benchmark_price: { type: 'string', description: 'What customers say about pricing vs competitors.' },
          },
          required: ['general_impression', 'themes', 'benchmark_product', 'benchmark_price'],
        },
        prospecting: {
          type: 'object',
          properties: {
            potential_summary: { type: 'string', description: 'Narrative on the potential of prospects for this category.' },
            barriers: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  count: { type: 'integer' },
                },
                required: ['label', 'count'],
              },
            },
          },
          required: ['potential_summary', 'barriers'],
        },
      },
      required: ['existing_customers', 'prospecting'],
    }])),
    required: CATEGORY_KEYS,
  },
};

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: 'ANTHROPIC_API_KEY ontbreekt op de server (Cloudflare Pages > Settings > Environment variables).' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Ongeldige request body.' }, 400);
  }

  const aggregation = body.aggregation || {};
  const prompt = buildPrompt(aggregation);

  const model = env.CLAUDE_MODEL || 'claude-sonnet-4-5';

  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        tools: [ANALYSIS_TOOL],
        tool_choice: { type: 'tool', name: 'submit_analysis' },
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      return jsonResponse({ error: `Claude API fout (${apiRes.status}): ${errText}` }, 502);
    }

    const data = await apiRes.json();
    const toolUse = (data.content || []).find((b) => b.type === 'tool_use');
    if (!toolUse) {
      return jsonResponse({ error: 'Geen gestructureerd antwoord ontvangen van Claude.' }, 502);
    }
    return jsonResponse({ categories: toolUse.input });
  } catch (err) {
    return jsonResponse({ error: 'Onverwachte fout: ' + err.message }, 500);
  }
}

function buildPrompt(aggregation) {
  const parts = ['Je analyseert feedback van sales-bezoekrapporten voor Winsol (zonwering: screens, rolluiken, luifels, pergolas).',
    'Voor elke productcategorie krijg je: het aantal bestaande klanten met input, hun losse opmerkingen (remarks), het aantal prospects, het geschatte potentieel in euro, en hun opmerkingen.',
    'Geef per categorie een genuanceerde, feitelijke synthese in het Nederlands. Verzin geen cijfers die niet uit de remarks af te leiden zijn — "count" bij een thema/drempel is het aantal remarks dat dat standpunt weerspiegelt.',
    'Als er voor een categorie geen of nauwelijks remarks zijn, zeg dat expliciet (bv. "onvoldoende data") in plaats van iets te verzinnen.',
    '', '--- DATA ---'];

  for (const cat of CATEGORY_KEYS) {
    const c = aggregation[cat] || { existing: { n: 0, remarks: [] }, prospecting: { n: 0, potentialSum: 0, remarks: [] } };
    parts.push(`\n## Categorie: ${cat}`);
    parts.push(`Bestaande klanten: ${c.existing.n} rapporten.`);
    parts.push('Remarks bestaande klanten:\n' + (c.existing.remarks.length ? c.existing.remarks.map((r) => '- ' + r).join('\n') : '(geen)'));
    parts.push(`Prospects: ${c.prospecting.n} rapporten, geschat potentieel €${Math.round(c.prospecting.potentialSum)}.`);
    parts.push('Remarks prospects:\n' + (c.prospecting.remarks.length ? c.prospecting.remarks.map((r) => '- ' + r).join('\n') : '(geen)'));
  }

  return parts.join('\n');
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
