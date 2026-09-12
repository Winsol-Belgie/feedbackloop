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
// De frontend filtert de opmerkingen al vooraf per categorie (fragmenten
// die duidelijk over een ándere categorie gaan worden weggelaten — zie
// filterRemarkForCategory in app.js). De instructie hieronder is de tweede
// laag van diezelfde bescherming: mocht er toch nog gemengde inhoud
// binnenkomen, dan negeert Claude expliciet wat niet over de gevraagde
// categorie gaat.
//
// Claude krijgt per klant-opmerking ook de klantnaam mee, en moet in zijn
// thema's/meldingen/wensen/drempels exact diezelfde namen citeren (i.p.v.
// enkel een cijfer op te geven) — zo blijft "hoeveel klanten" herleidbaar
// tot wélke klanten, in plaats van een verzonnen telling.
//
// Voor "Deel 1 — Bestaande klanten" wordt de input in drie aparte groepen
// gesplitst (themes / technical_issues / feature_requests) i.p.v. één
// algemene lijst — dat is precies de indeling die bruikbaar is als input
// voor een R&D/PM-roadmap: sentiment apart van concrete defecten, en
// defecten apart van functiewensen.

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
            description: 'General voice-of-customer sentiment/experience themes (satisfaction, impression, service, ...). Not technical defects and not feature requests — those go in the separate fields below.',
          },
          customer_sentiments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Het opmerking-id zoals meegegeven bij "BESTAANDE KLANTEN", bv. "R3".' },
                customer: { type: 'string', description: 'Exacte klantnaam (letterlijk overgenomen) bij dit id.' },
                sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral', 'no_opinion'], description: '"no_opinion" voor een loutere bezoeknotitie zonder uitgesproken oordeel.' },
              },
              required: ['id', 'customer', 'sentiment'],
            },
            description: 'VERPLICHT en UITPUTTEND: exact één entry per genummerd opmerking-id uit "BESTAANDE KLANTEN" (in dezelfde volgorde, geen enkele overslaan). Dit — niet "themes" — is de basis voor de score-berekening in de tool; "themes" blijft apart voor de tekstuele samenvatting.',
          },
          technical_issues: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Concrete technical problem/defect/complaint, e.g. "motor defect na installatie".' },
                customers: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Exact customer names (copied verbatim) reporting this issue.',
                },
              },
              required: ['label', 'customers'],
            },
            description: 'Concrete technical problems, defects, quality or installation/service complaints — grouped by topic. Empty array if none reported. This is the primary input for R&D quality follow-up.',
          },
          feature_requests: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Functionality/option the customer misses or explicitly wants, e.g. "gemotoriseerde bediening via app".' },
                customers: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Exact customer names (copied verbatim) who mentioned this.',
                },
              },
              required: ['label', 'customers'],
            },
            description: 'Missing functionality or explicitly wished-for features/options — grouped by topic. Empty array if none reported. This is the primary input for product roadmap prioritisation.',
          },
          benchmark_product: { type: 'string', description: 'What customers say about specs/offering vs competitors.' },
          benchmark_price: { type: 'string', description: 'What customers say about pricing vs competitors.' },
        },
        required: ['general_impression', 'themes', 'customer_sentiments', 'technical_issues', 'feature_requests', 'benchmark_product', 'benchmark_price'],
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

// Klein, apart tool-schema voor de globale (cross-categorie) samenvatting
// — zie GLOBAL_SUMMARY_TOOL hieronder voor de aanleiding.
const GLOBAL_SUMMARY_TOOL = {
  name: 'submit_global_summary',
  description: 'Short cross-category executive summary for a Winsol feedbackloop analysis.',
  input_schema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'Korte, feitelijke lopende samenvatting (NL, 3-6 zinnen) van hoe Winsol er in deze selectie voor staat: sterke punten en belangrijkste werkpunten, cross-categorie. Enkel gebaseerd op de meegegeven cijfers/labels.',
      },
    },
    required: ['summary'],
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

    // Aparte, lichte modus voor de "Globaal"-tab in de frontend: krijgt
    // enkel de al per categorie samengevatte cijfers/labels (geen ruwe
    // remarks) en schrijft daar een korte lopende tekst bij — dus een
    // kleine, snelle aanroep bovenop de 7 bestaande categorie-aanroepen,
    // niet nog eens de volledige analyse.
    if (body.mode === 'global_summary') {
      return handleGlobalSummary(body, env);
    }

    const category = body.category || 'onbekend';
    const existing = body.existing || { remarks: [] };
    const prospecting = body.prospecting || { remarks: [], potentialSum: 0 };
    const existingFmt = formatRemarksWithIds(existing.remarks);
    const prospectingText = formatRemarks(prospecting.remarks);
    const prompt = buildPrompt(category, existingFmt.text, existingFmt.ids, prospectingText, prospecting.potentialSum);
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
          max_tokens: 6000,
          temperature: 0,
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
      // Volledigheids-check: hoort exact één customer_sentiments-entry per
      // verstuurd opmerking-id te krijgen (zie formatRemarksWithIds hieronder).
      // Een tekort blokkeert de analyse niet — een onvolledig antwoord is nog
      // altijd bruikbaarder dan geen antwoord — maar wordt gelogd zodat het
      // zichtbaar is in de Worker-logs (wrangler tail).
      const gotIds = new Set((toolUse.input?.existing_customers?.customer_sentiments || []).map((s) => s.id));
      const missingIds = existingFmt.ids.filter((id) => !gotIds.has(id));
      if (missingIds.length) {
        console.warn(`[${category}] customer_sentiments mist ${missingIds.length}/${existingFmt.ids.length} id(s): ${missingIds.join(', ')}`);
      }
      return jsonResponse({ category, analysis: toolUse.input });
    } catch (err) {
      return jsonResponse({ error: 'Onverwachte fout: ' + err.message }, 500);
    }
  },
};

function buildPrompt(category, existingText, existingIds, prospectingText, potentialSum) {
  return [
    `Je analyseert feedback van sales-bezoekrapporten voor Winsol, specifiek voor de productcategorie "${category}" (zonwering/schrijnwerk).`,
    `BELANGRIJK — blijf strikt binnen categorie "${category}": een opmerking kan (fragmenten van) andere Winsol-productcategorieën vermelden (bv. screens, rolluiken, fusion, luifels, pergola, outdoor, home/schrijnwerk). Gebruik enkel het deel van een opmerking dat effectief over "${category}" gaat; negeer volledig wat over een andere categorie gaat, ook al staat het in dezelfde opmerking. Verzin geen thema, probleem, wens of drempel op basis van tekst die niet over "${category}" gaat.`,
    'Geef een genuanceerde, feitelijke synthese in het Nederlands. Verdeel de input voor bestaande klanten in drie aparte groepen (een opmerking mag in meerdere groepen terugkomen als ze meerdere aspecten bevat):',
    '1. "themes" — algemene ervaring/sentiment (tevredenheid, indruk, service in het algemeen, ...).',
    '2. "technical_issues" — concrete technische problemen, defecten, klachten over werking, kwaliteit, montage of service. Dit is input voor R&D-kwaliteitsopvolging.',
    '3. "feature_requests" — functionaliteit of opties die de klant mist of expliciet wenst. Dit is input voor de product-roadmap.',
    'Geef voor "technical_issues" en "feature_requests" gewoon een lege lijst terug als die er niet zijn — verzin niets.',
    'BELANGRIJK: bij elk thema/probleem/wens/drempel geef je een "customers"-lijst met de EXACTE klantnamen (letterlijk overgenomen, geen aanpassingen) van de klanten wiens opmerking dat standpunt weerspiegelt. Verzin geen klantnamen en verzin geen thema/probleem/wens zonder dat er minstens één klant met naam achter zit.',
    'Als er geen of nauwelijks (relevante) remarks zijn, zeg dat expliciet (bv. "onvoldoende data") in plaats van iets te verzinnen.',
    'BELANGRIJK — brede spreiding, geen schijnconsensus: veel remarks zijn loutere bezoeknotities zonder échte klantopinie (bv. "Bezoek", "Stalen afgegeven", "Offerte opgenomen") — daar valt geen thema uit te halen. Bouw thema\'s NIET door de opmerkingen van één en dezelfde klant meermaals te herformuleren tot ogenschijnlijk verschillende thema\'s: dat oogt als brede consensus terwijl het één mening is. Als de kwalitatieve inhoud in de praktijk van maar 1-2 klanten komt, beperk het aantal thema\'s daartoe en vermeld dat expliciet in "general_impression" (bv. "De meeste van de X rapporten zijn bezoeknotities zonder uitgesproken klantopinie; de feedback hieronder komt vrijwel volledig van klant Y."). Geef bij voorkeur, en enkel waar de data dat echt draagt, thema\'s die op verschillende klanten gebaseerd zijn.',
    '',
    '--- VERPLICHTE PER-OPMERKING CLASSIFICATIE (customer_sentiments) ---',
    'Naast "themes" geef je ook een apart veld "customer_sentiments" terug — geen samenvatting, maar een volledige en uitputtende lijst: exact één entry per genummerd opmerking-id hieronder bij "BESTAANDE KLANTEN" (elk id begint met "R", bv. "R1"), in dezelfde volgorde, zonder er één over te slaan en zonder ids te verzinnen.',
    `De ids die je moet gebruiken zijn: ${existingIds.join(', ') || '(geen)'}.`,
    'Ken per id exact één sentiment toe uit: "positive", "negative", "neutral", "no_opinion" — met deze betekenis:',
    '- "positive": de klant uit expliciete tevredenheid, lof, of wil de samenwerking duidelijk voortzetten/uitbreiden (bv. "zeer tevreden over levering", "wil graag opnieuw bestellen").',
    '- "negative": de klant uit een klacht, probleem, ontevredenheid, of overweegt/wil van leverancier wisselen (bv. "motor defect", "ontevreden over service", "klant twijfelt door slechte ervaring").',
    '- "neutral": een gemengd of louter feitelijk oordeel zonder duidelijke uitslag naar tevreden of ontevreden (bv. prijs/product vergeleken zonder waardeoordeel).',
    '- "no_opinion": zuiver administratieve notitie zonder enig oordeel over product/dienst (bv. "bezoek afgelegd", "staal afgegeven", "offerte besproken", "nog niet opgestart").',
    'Bij twijfel: een opgeloste klacht zonder verdere negatieve toon → "neutral" (niet "negative"); een aanhoudende/onopgeloste klacht → "negative"; een zuiver informatieve/administratieve zin zonder klantoordeel → "no_opinion" (niet "neutral").',
    'Deze lijst bepaalt rechtstreeks de betrouwbaarheidsscore in de tool — sla dus geen enkel id over, ook niet wanneer het overduidelijk "no_opinion" is.',
    '',
    '--- BESTAANDE KLANTEN ---',
    existingText,
    '',
    `--- PROSPECTS (geschat totaal potentieel €${Math.round(potentialSum || 0)}) ---`,
    prospectingText,
  ].join('\n');
}

function formatRemarks(remarks) {
  if (!remarks || !remarks.length) return '(geen)';
  return remarks.map((r) => `- [${r.name}] ${r.remark}`).join('\n');
}

// Zoals formatRemarks, maar met een stabiel volgnummer (R1, R2, ...) per
// opmerking — nodig zodat de AI in "customer_sentiments" exact kan
// terugverwijzen naar welke opmerking ze classificeert, en zodat de Worker
// achteraf kan controleren of alle ids ook echt een classificatie kregen.
function formatRemarksWithIds(remarks) {
  if (!remarks || !remarks.length) return { text: '(geen)', ids: [] };
  const ids = remarks.map((_, i) => `R${i + 1}`);
  const text = remarks.map((r, i) => `- [${ids[i]}] [${r.name}] ${r.remark}`).join('\n');
  return { text, ids };
}

async function handleGlobalSummary(body, env) {
  const categories = Array.isArray(body.categories) ? body.categories : [];
  const prompt = buildGlobalSummaryPrompt(categories);
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
        max_tokens: 1024,
        temperature: 0,
        tools: [GLOBAL_SUMMARY_TOOL],
        tool_choice: { type: 'tool', name: 'submit_global_summary' },
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
      return jsonResponse({ error: 'Geen samenvatting ontvangen van Claude.' }, 502);
    }
    return jsonResponse({ summary: toolUse.input.summary });
  } catch (err) {
    return jsonResponse({ error: 'Onverwachte fout: ' + err.message }, 500);
  }
}

function buildGlobalSummaryPrompt(categories) {
  const blocks = categories.map((c) => {
    const lines = [
      `## ${c.label}`,
      `Score: ${c.scoreLabel} (gebaseerd op ${c.sampleSize} van ${c.totalCustomers} bestaande klanten met een uitgesproken opinie)`,
    ];
    if (c.topPositive && c.topPositive.length) {
      lines.push(`Sterke punten: ${c.topPositive.map((p) => `${p.label} (${p.count})`).join('; ')}`);
    }
    if (c.topIssues && c.topIssues.length) {
      lines.push(`Technische meldingen: ${c.topIssues.map((p) => `${p.label} (${p.count})`).join('; ')}`);
    }
    if (c.topWishes && c.topWishes.length) {
      lines.push(`Gewenste features: ${c.topWishes.map((p) => `${p.label} (${p.count})`).join('; ')}`);
    }
    return lines.join('\n');
  }).join('\n\n');

  return [
    'Je krijgt een cross-categorie samenvatting van een Winsol feedbackloop-analyse (zonwering/schrijnwerk), al per productcategorie samengevat (score, sterke punten, technische meldingen, gewenste features).',
    'Schrijf een korte, feitelijke lopende samenvatting in het Nederlands (3-6 zinnen) van hoe Winsol er in deze selectie voor staat: waar het sterk staat, en wat de belangrijkste werkpunten zijn, over de categorieën heen.',
    'Gebruik UITSLUITEND de onderstaande gegevens — verzin geen cijfers, labels of klantnamen die niet letterlijk gegeven zijn.',
    'Als een score gebaseerd is op weinig klanten (sample klein t.o.v. het totaal), benoem dat expliciet in plaats van de conclusie te stellig te brengen.',
    '',
    blocks || '(geen categorieën met data)',
  ].join('\n');
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
