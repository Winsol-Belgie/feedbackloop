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
// tags/drempels exact diezelfde namen citeren (i.p.v. enkel een cijfer op
// te geven) — zo blijft "hoeveel klanten" herleidbaar tot wélke klanten, in
// plaats van een verzonnen telling.
//
// VASTE TAXONOMIE i.p.v. vrije "themes" (sinds de taxonomie-herbouw): in
// plaats van zelf thema's/technische meldingen/features te laten verzinnen
// (wat als losse, niet-optelbare opsomming aanvoelde bij grotere datasets),
// classificeert Claude elke opmerking met vaste domein+onderwerp-tags uit
// TOPIC_TAXONOMY hieronder. Dat maakt de output telbaar en vergelijkbaar
// over categorieën én maanden heen (zie app.js: groupTopicTags/
// buildGlobalOverview), en scheidt meteen R&D-relevante productsignalen
// van de veel talrijkere commerciële/dealerrelatie-inhoud die in de
// bezoekrapporten overheerst (bevestigd bij analyse van 6 maanden data).

// Bron van waarheid voor de vaste taxonomie — ook gebruikt in app.js
// (TAXONOMY, daar losstaand gedefinieerd want de Worker en de frontend
// draaien apart; bij een wijziging hier dus ook app.js aanpassen).
const TOPIC_TAXONOMY = {
  product_techniek: {
    label: 'Product & Techniek',
    note: 'dit is de kern voor R&D',
    topics: {
      onderdeel_defect: 'defect, kapot, kras, put, lek, storing aan een onderdeel of product.',
      bediening_domotica: 'motor, afstandsbediening, app, domotica, bediening.',
      kleur_afwerking: 'kleur, RAL, afwerking, coating.',
      maatvoering_beperking: 'afmetingen, technische/constructieve beperking.',
      feature_wens: 'functionaliteit of optie die de klant expliciet mist of wenst (input voor productroadmap).',
    },
  },
  levering_logistiek: {
    label: 'Levering & Logistiek',
    topics: {
      levertermijn: 'levertermijn/doorlooptijd te lang of vertraging.',
      foutieve_levering: 'onvolledige, foutieve of beschadigde levering.',
      transportplanning: 'planning/organisatie van transport/levering.',
    },
  },
  service_herstelling: {
    label: 'Service & Herstelling',
    topics: {
      sav_opvolging: 'opvolging van klachten, reactietijd van de dienst na verkoop.',
      herstelling_garantie: 'herstelling, garantie, creditnota voor een probleem.',
    },
  },
  prijs_concurrentie: {
    label: 'Prijs & Concurrentiepositie',
    topics: {
      prijsvergelijking: 'klant vergelijkt prijs/aanbod met een specifieke concurrent (vermeld de concurrent-naam in "competitor" indien genoemd).',
      marge_korting: 'marge- of kortingsdiscussie tussen Winsol en de dealer.',
    },
  },
  tools_ondersteuning: {
    label: 'Tools & Ondersteuning',
    topics: {
      wincal: 'het configuratie-/bestelprogramma Wincal.',
      opleiding_documentatie: 'opleiding, documentatie, stalen, folders.',
    },
  },
  commercieel: {
    label: 'Commerciële dynamiek',
    note: 'géén roadmap-signaal, wel context',
    topics: {
      leads_pipeline: 'leads, pipeline, omzet, bestelvolume.',
      marketing_acties: 'marketingacties, beurzen, foldercampagnes, website.',
      dealer_organisatie: 'interne organisatie van de dealer (zaakvoerderswissel, personeel, showroom).',
    },
  },
};

const DOMAIN_KEYS = Object.keys(TOPIC_TAXONOMY);
const TOPIC_KEYS = DOMAIN_KEYS.flatMap((d) => Object.keys(TOPIC_TAXONOMY[d].topics));

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
            description: 'VERPLICHT en UITPUTTEND: exact één entry per genummerd opmerking-id uit "BESTAANDE KLANTEN" (in dezelfde volgorde, geen enkele overslaan). Dit is de basis voor de score-berekening in de tool.',
          },
          topic_tags: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Het opmerking-id (zie customer_sentiments), bv. "R3".' },
                customer: { type: 'string', description: 'Exacte klantnaam (letterlijk overgenomen) bij dit id.' },
                domain: { type: 'string', enum: DOMAIN_KEYS, description: 'Vast domein uit de taxonomie — zie prompt.' },
                topic: { type: 'string', enum: TOPIC_KEYS, description: 'Vast onderwerp uit de taxonomie — zie prompt.' },
                sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'], description: 'Sentiment t.o.v. dit specifieke onderwerp (niet de klant in het algemeen).' },
                detail: { type: 'string', description: 'Korte, concrete beschrijving (max. 1 zin) van wat deze opmerking hierover zegt — geen vage samenvatting.' },
                competitor: { type: 'string', description: 'Enkel bij topic "prijsvergelijking": naam van de vermelde concurrent. Leeg laten indien niet van toepassing of niet genoemd.' },
              },
              required: ['id', 'customer', 'domain', 'topic', 'sentiment', 'detail'],
            },
            description: 'Vaste domein/onderwerp-classificatie per opmerking (zie taxonomie in de prompt) — dit vervangt vrije "themes": elke opmerking met classificeerbare inhoud krijgt hier één of meer tags (0 tags toegestaan voor zuiver administratieve opmerkingen zonder enig classificeerbaar aspect).',
          },
          benchmark_product: { type: 'string', description: 'What customers say about specs/offering vs competitors.' },
          benchmark_price: { type: 'string', description: 'What customers say about pricing vs competitors.' },
        },
        required: ['general_impression', 'customer_sentiments', 'topic_tags', 'benchmark_product', 'benchmark_price'],
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
      // zichtbaar is in de Worker-logs (wrangler tail). topic_tags is bewust
      // NIET exhaustief (zuiver administratieve opmerkingen mogen 0 tags
      // krijgen), dus daar geldt geen gelijkaardige check.
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

// Bouwt het taxonomie-blok van de prompt uit TOPIC_TAXONOMY zelf (i.p.v.
// het hardcoded uit te schrijven) — zo kan de lijst hierboven uitgebreid
// worden zonder de prompttekst apart te moeten bijwerken.
function buildTaxonomyBlock() {
  const lines = ['Gebruik UITSLUITEND onderstaande domein/onderwerp-combinaties (geen eigen varianten, geen nieuwe onderwerpen verzinnen):', ''];
  for (const domainKey of DOMAIN_KEYS) {
    const d = TOPIC_TAXONOMY[domainKey];
    lines.push(`Domein "${domainKey}" (${d.label}${d.note ? ' — ' + d.note : ''}):`);
    for (const topicKey of Object.keys(d.topics)) {
      lines.push(`  - "${topicKey}": ${d.topics[topicKey]}`);
    }
  }
  return lines.join('\n');
}

function buildPrompt(category, existingText, existingIds, prospectingText, potentialSum) {
  return [
    `Je analyseert feedback van sales-bezoekrapporten voor Winsol, specifiek voor de productcategorie "${category}" (zonwering/schrijnwerk).`,
    `BELANGRIJK — blijf strikt binnen categorie "${category}": een opmerking kan (fragmenten van) andere Winsol-productcategorieën vermelden (bv. screens, rolluiken, fusion, luifels, pergola, outdoor, home/schrijnwerk). Gebruik enkel het deel van een opmerking dat effectief over "${category}" gaat; negeer volledig wat over een andere categorie gaat, ook al staat het in dezelfde opmerking. Verzin geen tag, wens of drempel op basis van tekst die niet over "${category}" gaat.`,
    'Geef een genuanceerde, feitelijke synthese in het Nederlands.',
    '',
    '--- VASTE TAXONOMIE (topic_tags) ---',
    'In plaats van zelf thema\'s te verzinnen, classificeer je élke opmerking die een classificeerbaar aspect bevat met één of meer vaste tags uit onderstaande lijst (domein + onderwerp). Eén opmerking mag meerdere tags krijgen als ze meerdere aspecten bevat (bv. zowel een levertermijn-klacht als een prijsvergelijking). Opmerkingen die louter administratief zijn zonder enig classificeerbaar aspect (bv. "Bezoek afgelegd", "Stalen afgegeven") mogen 0 tags krijgen — verzin er niets bij.',
    buildTaxonomyBlock(),
    '',
    'Voor elke tag geef je: het opmerking-id (zie hieronder bij "BESTAANDE KLANTEN"), de exacte klantnaam, het domein, het onderwerp, een sentiment ("positive"/"negative"/"neutral" — t.o.v. DIT specifieke onderwerp, niet de klant in het algemeen), en een korte "detail"-tekst (max. 1 zin, concreet en specifiek — bv. "PVC levertermijn nu 8-10 weken i.p.v. gebruikelijke 5 weken", NIET "levertermijn is een probleem"). Bij onderwerp "prijsvergelijking" vermeld je in "competitor" de naam van de concurrent indien genoemd (leeg laten indien niet van toepassing).',
    'BELANGRIJK: verzin geen tag, klantnaam of "detail" die niet gedragen wordt door de tekst van de opmerking zelf. Gebruik nooit een domein/onderwerp buiten de vaste lijst hierboven.',
    '',
    '--- VERPLICHTE PER-OPMERKING CLASSIFICATIE (customer_sentiments) ---',
    'Naast "topic_tags" geef je ook een apart veld "customer_sentiments" terug — geen samenvatting, maar een volledige en uitputtende lijst: exact één entry per genummerd opmerking-id hieronder bij "BESTAANDE KLANTEN" (elk id begint met "R", bv. "R1"), in dezelfde volgorde, zonder er één over te slaan en zonder ids te verzinnen.',
    `De ids die je moet gebruiken zijn: ${existingIds.join(', ') || '(geen)'}.`,
    'Ken per id exact één sentiment toe uit: "positive", "negative", "neutral", "no_opinion" — met deze betekenis:',
    '- "positive": de klant uit expliciete tevredenheid, lof, of wil de samenwerking duidelijk voortzetten/uitbreiden (bv. "zeer tevreden over levering", "wil graag opnieuw bestellen").',
    '- "negative": de klant uit een klacht, probleem, ontevredenheid, of overweegt/wil van leverancier wisselen (bv. "motor defect", "ontevreden over service", "klant twijfelt door slechte ervaring").',
    '- "neutral": een gemengd of louter feitelijk oordeel zonder duidelijke uitslag naar tevreden of ontevreden (bv. prijs/product vergeleken zonder waardeoordeel).',
    '- "no_opinion": zuiver administratieve notitie zonder enig oordeel over product/dienst (bv. "bezoek afgelegd", "staal afgegeven", "offerte besproken", "nog niet opgestart").',
    'Bij twijfel: een opgeloste klacht zonder verdere negatieve toon → "neutral" (niet "negative"); een aanhoudende/onopgeloste klacht → "negative"; een zuiver informatieve/administratieve zin zonder klantoordeel → "no_opinion" (niet "neutral").',
    'Deze lijst bepaalt rechtstreeks de betrouwbaarheidsscore in de tool — sla dus geen enkel id over, ook niet wanneer het overduidelijk "no_opinion" is.',
    '',
    'BELANGRIJK — brede spreiding, geen schijnconsensus: veel remarks zijn loutere bezoeknotities zonder échte klantopinie — daar valt geen tag uit te halen. Groepeer een onderwerp NIET breder dan de data draagt: als de kwalitatieve inhoud in de praktijk van maar 1-2 klanten komt, benoem dat expliciet in "general_impression" (bv. "De meeste opmerkingen hier zijn bezoeknotities zonder uitgesproken klantopinie; de feedback komt vrijwel volledig van klant Y.") in plaats van dat te laten lijken op een breed gedragen patroon.',
    'Als er geen of nauwelijks (relevante) remarks zijn, zeg dat expliciet (bv. "onvoldoende data") in plaats van iets te verzinnen.',
    'BELANGRIJK — geen absolute aantallen in "general_impression": de opmerkingen die je hier krijgt kunnen een deelverzameling zijn van een groter geheel voor deze categorie (grote categorieën worden in meerdere stukken tegelijk verwerkt en nadien samengevoegd — jij ziet mogelijk niet alle opmerkingen). Vermeld daarom NOOIT een concreet aantal rapporten/opmerkingen (bv. "de meeste van de 26 rapporten"), want dat aantal klopt mogelijk niet met het totaal voor de hele categorie. Gebruik in plaats daarvan relatieve bewoordingen zonder getal, zoals "de meeste opmerkingen hier", "een minderheid", of "vrijwel alle".',
    '',
    '--- PROSPECTS: potential_summary / barriers ---',
    'Analyseer het PROSPECTS-gedeelte hieronder (potentiële klanten, nog geen bestaande klant) even grondig als de bestaande klanten hierboven — dit is geen bijzaak. In "potential_summary" geef je een feitelijke synthese van het commerciële potentieel voor deze categorie bij deze prospects: welke concrete interesse/vraag blijkt uit de opmerkingen, welke signalen wijzen op een reële kans (bv. concrete offerteaanvraag, expliciete interesse in dit product), en hoe verhoudt dat zich tot het vermelde geschatte totaalpotentieel. Als er geen of nauwelijks bruikbare prospect-opmerkingen zijn, zeg dat expliciet (bv. "onvoldoende data over prospects voor deze categorie") — laat "potential_summary" nooit leeg en verzin niets.',
    'In "barriers" groepeer je concrete drempels/obstakels die uit de prospect-opmerkingen blijken en die verklaren waarom een prospect nog niet converteert (bv. prijs te hoog, kiest voor een concurrent, wacht op budget, technische twijfel, nog in oriëntatiefase). Elke barrier krijgt een korte "label" en de exacte klantnamen die deze drempel vermelden. Verzin geen barrier zonder tekstuele basis in de opmerkingen; zijn er geen duidelijke drempels te herkennen, geef dan gewoon een lege array terug.',
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
// opmerking — nodig zodat de AI in "customer_sentiments"/"topic_tags" exact
// kan terugverwijzen naar welke opmerking ze classificeert, en zodat de
// Worker achteraf kan controleren of alle ids ook echt een classificatie
// kregen (customer_sentiments).
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
