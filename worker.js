// Cloudflare Worker — losstaande API voor de feedbackloop-tool.
// De frontend (index.html/app.js) draait op GitHub Pages; deze Worker is
// het analyse-endpoint, cross-origin aangeroepen (CORS hieronder). De
// Anthropic API-sleutel staat alleen hier (wrangler secret), nooit in de
// frontend-code.
//
// Verwerkt ÉÉN categorie per aanroep (de frontend doet 7 parallelle
// aanroepen, één per categorie) — dat houdt elke prompt klein/snel, geeft
// de frontend een natuurlijk voortgangspunt (x van y klaar), en was ook de
// fix voor de 502 die optrad toen alle categorieën in één grote aanroep
// zaten.
//
// Claude krijgt per klant-opmerking ook de klantnaam mee, en moet in zijn
// thema's/drempels exact diezelfde namen citeren (i.p.v. enkel een cijfer
// op te geven) — zo blijft "hoeveel klanten" herleidbaar tot wélke klanten,
// in plaats van een verzonnen telling.

const ANALYSIS_TOOL = {
  name: 'submit_analysis',
  description: 'Structured feedbackloop analysis for one product category.',
  input_schema: {
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
                sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
                customers: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Exact customer names (copied verbatim from the provided remarks) whose remark reflects this viewpoint.',
                },
              },
              required: ['label', 'sentiment', 'customers'],
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
                customers: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Exact customer names (copied verbatim) whose remark reflects this barrier.',
                },
              },
              required: ['label', 'customers'],
            },
          },
        },
        required: ['potential_summary', 'barriers'],
      },
    },
    required: ['existing_customers', 'prospecting'],
  },
};

const ALLOWED_ORIGIN = '*';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    if (!env.ANTHROPIC_API_KEY) {
      return jsonResponse({ error: 'ANTHROPIC_API_KEY ontbreekt (wrangler secret put ANTHROPIC_API_KEY).' }, 500);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Ongeldige request body.' }, 400);
    }

    const category = body.category || 'onbekend';
    const existing = body.existing || { remarks: [] };
    const prospecting = body.prospecting || { remarks: [], potentialSum: 0 };
    const prompt = buildPrompt(category, existing, prospecting);
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
      return jsonResponse({ category, analysis: toolUse.input });
    } catch (err) {
      return jsonResponse({ error: 'Onverwachte fout: ' + err.message }, 500);
    }
  },
};

function buildPrompt(category, existing, prospecting) {
  return [
    `Je analyseert feedback van sales-bezoekrapporten voor Winsol, specifiek voor de productcategorie "${category}" (zonwering/schrijnwerk).`,
    'Geef een genuanceerde, feitelijke synthese in het Nederlands.',
    'BELANGRIJK: bij elk thema/elke drempel geef je een "customers"-lijst met de EXACTE klantnamen (letterlijk overgenomen, geen aanpassingen) van de klanten wiens opmerking dat standpunt weerspiegelt. Verzin geen klantnamen en verzin geen thema zonder dat er minstens één klant met naam achter zit.',
    'Als er geen of nauwelijks remarks zijn, zeg dat expliciet (bv. "onvoldoende data") in plaats van iets te verzinnen.',
    '',
    '--- BESTAANDE KLANTEN ---',
    formatRemarks(existing.remarks),
    '',
    `--- PROSPECTS (geschat totaal potentieel €${Math.round(prospecting.potentialSum || 0)}) ---`,
    formatRemarks(prospecting.remarks),
  ].join('\n');
}

function formatRemarks(remarks) {
  if (!remarks || !remarks.length) return '(geen)';
  return remarks.map((r) => `- [${r.name}] ${r.remark}`).join('\n');
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders() },
  });
}
