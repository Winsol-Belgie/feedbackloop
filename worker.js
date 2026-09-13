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

// Zelfde 7 categorieën als CATEGORY_LABELS in app.js — hier enkel nodig om
// de gecachete weergave (Fase 5) altijd een consistente vorm te laten
// teruggeven, ook voor een categorie zonder enige gecachete opmerking.
const CATEGORY_KEYS = ['screens', 'shutters', 'fusion', 'awnings', 'pergola', 'outdoor', 'home'];
// De client stuurt de categorie als leesbaar label mee (CATEGORY_LABELS in
// app.js, bv. "Outdoor"), omdat dat label ook in de AI-prompt gebruikt
// wordt. Voor de cache (Fase 4/5) hebben we net de interne sleutel nodig
// (CATEGORY_KEYS hierboven, bv. "outdoor") — anders matcht handleCachedResults
// nooit iets (rec.category zou dan altijd het label zijn, nooit de sleutel
// waarop hieronder geïndexeerd wordt). Vandaar deze omzetting.
const LABEL_TO_KEY = {
  Screens: 'screens',
  Rolluiken: 'shutters',
  Fusion: 'fusion',
  Luifels: 'awnings',
  Pergola: 'pergola',
  Outdoor: 'outdoor',
  Home: 'home',
};
const TOPIC_KEYS = DOMAIN_KEYS.flatMap((d) => Object.keys(TOPIC_TAXONOMY[d].topics));

const ANALYSIS_TOOL = {
  name: 'submit_analysis',
  description: 'Structured feedbackloop analysis for one product category.',
  input_schema: {
    type: 'object',
    properties: {
      existing_customers: {
        type: 'object',
        // Volgorde bewust NIET alfabetisch/oorspronkelijk: "customer_sentiments"
        // staat hier eerst, vóór de vrije verhalende velden. Diagnose (i.o.v.
        // Gwenn, na een reeks 3/5-maanden BE-tests): bij grote categorieën
        // (bv. Home 83, Screens 39, Pergola 38 bestaande klanten) liep de AI
        // tegen de max_tokens-limiet aan (stop_reason "max_tokens"), en het
        // model genereert de velden in zowat de volgorde van dit schema. Met
        // "general_impression" eerst ging het budget vaak op aan de
        // verhalende tekst nog vóór de VERPLICHTE/UITPUTTENDE
        // customer_sentiments-lijst (die de score bepaalt) aan bod kwam —
        // bij de kleinste van de vier (Rolluiken, 33 klanten) kwam die lijst
        // wél volledig binnen, ook al werd ook daar de max_tokens-limiet
        // bereikt (verderop, dus na customer_sentiments). Door de
        // score-kritische/verplichte velden hier eerst te zetten, valt bij
        // afkapping enkel de al gracieus opgevangen verhalende tekst weg
        // (general_impression/benchmark_*), niet de cijfers.
        properties: {
          customer_sentiments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Het opmerking-id zoals meegegeven bij "BESTAANDE KLANTEN", bv. "R3".' },
                sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral', 'no_opinion'], description: '"no_opinion" voor een loutere bezoeknotitie zonder uitgesproken oordeel.' },
              },
              required: ['id', 'sentiment'],
            },
            description: 'VERPLICHT en UITPUTTEND: exact één entry per genummerd opmerking-id uit "BESTAANDE KLANTEN" (in dezelfde volgorde, geen enkele overslaan). Dit is de basis voor de score-berekening in de tool — genereer dit veld als EERSTE, vóór de andere velden van existing_customers.',
          },
          topic_tags: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Het opmerking-id (zie customer_sentiments), bv. "R3".' },
                domain: { type: 'string', enum: DOMAIN_KEYS, description: 'Vast domein uit de taxonomie — zie prompt.' },
                topic: { type: 'string', enum: TOPIC_KEYS, description: 'Vast onderwerp uit de taxonomie — zie prompt.' },
                sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'], description: 'Sentiment t.o.v. dit specifieke onderwerp (niet de klant in het algemeen).' },
                detail: { type: 'string', description: 'Korte, concrete beschrijving (max. 1 zin) van wat deze opmerking hierover zegt — geen vage samenvatting.' },
                competitor: { type: 'string', description: 'Enkel bij topic "prijsvergelijking": naam van de vermelde concurrent. Leeg laten indien niet van toepassing of niet genoemd.' },
              },
              required: ['id', 'domain', 'topic', 'sentiment', 'detail'],
            },
            description: 'Vaste domein/onderwerp-classificatie per opmerking (zie taxonomie in de prompt) — dit vervangt vrije "themes": elke opmerking met classificeerbare inhoud krijgt hier één of meer tags (0 tags toegestaan voor zuiver administratieve opmerkingen zonder enig classificeerbaar aspect).',
          },
          benchmark_product: { type: 'string', description: 'What customers say about specs/offering vs competitors.' },
          benchmark_price: { type: 'string', description: 'What customers say about pricing vs competitors.' },
          general_impression: { type: 'string', description: 'Narrative summary (NL) of how existing customers experience the product, positive and negative. Genereer dit veld als LAATSTE van existing_customers.' },
        },
        required: ['customer_sentiments', 'topic_tags', 'benchmark_product', 'benchmark_price', 'general_impression'],
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

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Ongeldige request body.' }, 400);
    }

    // --- Auth-routes: geen ANTHROPIC_API_KEY nodig, geen AI-aanroep. ---
    if (body.mode === 'login') return handleLogin(body, env);
    if (body.mode === 'logout') return handleLogout(request, env);
    if (body.mode === 'auth_me') {
      const session = await getSession(request, env);
      return session
        ? jsonResponse({ username: session.username, role: session.role })
        : jsonResponse({ error: 'Niet ingelogd of sessie verlopen.' }, 401);
    }

    // --- Alles hieronder vereist een geldige, ingelogde sessie. ---
    const session = await getSession(request, env);
    if (!session) {
      return jsonResponse({ error: 'Niet ingelogd of sessie verlopen.' }, 401);
    }

    // Fase 5: de gecachete weergave (filters op reeds geanalyseerde data,
    // zonder nieuwe AI-aanroep) is precies wat de "user"-rol te zien
    // krijgt — dus toegankelijk voor élke ingelogde rol, vóór de
    // admin-only check hieronder (in tegenstelling tot uploaden/analyseren
    // zelf, dat wel admin-only blijft).
    if (body.mode === 'cached_options') {
      return handleCachedOptions(env);
    }
    if (body.mode === 'cached_results') {
      return handleCachedResults(body, env);
    }

    // Uploaden/analyseren is enkel voor admins.
    if (session.role !== 'admin') {
      return jsonResponse({ error: 'Enkel toegankelijk voor admins.' }, 403);
    }

    // Users beheren (Fase 2) is ook admin-only maar heeft geen AI-aanroep
    // nodig — dus vóór de ANTHROPIC_API_KEY-check, net als global_summary.
    if (body.mode === 'admin_upsert_users') {
      return handleAdminUpsertUsers(body, env);
    }

    // Fase 4: cache-beheer (per-opmerking AI-classificatie in KV) — ook
    // geen AI-aanroep nodig.
    if (body.mode === 'cache_invalidate_files') {
      return handleCacheInvalidateFiles(body, env);
    }
    if (body.mode === 'cache_reset') {
      return handleCacheReset(env);
    }

    if (!env.ANTHROPIC_API_KEY) {
      return jsonResponse({ error: 'ANTHROPIC_API_KEY ontbreekt (wrangler secret put ANTHROPIC_API_KEY).' }, 500);
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
      // Zonder timeout kan een trage/hangende Claude-aanroep de hele
      // request onbeperkt laten wachten — de client heeft dan geen enkel
      // signaal (geen foutmelding, geen retry) en "Opladen"/"Filteren"
      // lijkt voor altijd vast te lopen op "X/7 categorieën verwerkt".
      // Na ANALYZE_TIMEOUT_MS geven we zelf op met een nette 5xx, zodat de
      // client (fetchAnalysisBatch in app.js) dat als tijdelijke fout
      // herkent en automatisch een nieuwe poging doet.
      const ANALYZE_TIMEOUT_MS = 90000;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), ANALYZE_TIMEOUT_MS);
      let apiRes;
      try {
        apiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            max_tokens: 8192,
            temperature: 0,
            tools: [ANALYSIS_TOOL],
            tool_choice: { type: 'tool', name: 'submit_analysis' },
            messages: [{ role: 'user', content: prompt }],
          }),
          signal: controller.signal,
        });
      } catch (fetchErr) {
        if (fetchErr.name === 'AbortError') {
          return jsonResponse({ error: `Claude API timeout na ${ANALYZE_TIMEOUT_MS / 1000}s (categorie: ${category}).` }, 504);
        }
        throw fetchErr;
      } finally {
        clearTimeout(timeoutId);
      }

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
      // De AI geeft enkel nog het opmerking-id terug, niet de klantnaam: die
      // stond vroeger in ELKE customer_sentiments- én topic_tags-entry, terwijl
      // ze volledig afleidbaar is uit het id (zie formatRemarksWithIds: ids[i]
      // hoort bij remarks[i]). Dat was pure generatietijd — het model moest per
      // opmerking de volledige klantnaam 3 à 4 keer uitschrijven — en meteen ook
      // een foutenbron (verkeerd overgetypte namen). De Worker vult ze hier zelf
      // aan, zodat de client exact dezelfde structuur blijft krijgen.
      const nameById = new Map(existingFmt.ids.map((id, i) => [id, existing.remarks[i]?.name || '']));
      const fillCustomer = (entry) => {
        if (entry && !entry.customer) entry.customer = nameById.get(entry.id) || '';
        return entry;
      };
      (toolUse.input?.existing_customers?.customer_sentiments || []).forEach(fillCustomer);
      (toolUse.input?.existing_customers?.topic_tags || []).forEach(fillCustomer);

      const gotIds = new Set((toolUse.input?.existing_customers?.customer_sentiments || []).map((s) => s.id));
      const missingIds = existingFmt.ids.filter((id) => !gotIds.has(id));
      // Diagnose (i.o.v. Gwenn): "Screens" en "Home" kwamen herhaaldelijk
      // met 0 bruikbare customer_sentiments terug, ook bij een verse
      // "Opladen" (dus geen cache-kwestie). missingIds/stop_reason werden
      // hier al berekend maar enkel gelogd via console.warn — onzichtbaar
      // zonder "wrangler tail". Voortaan ook teruggegeven in de respons,
      // zodat de client dit kan tonen i.p.v. dat we blind moeten gokken
      // (bv. of het antwoord werd afgekapt door de max_tokens-limiet).
      const stopReason = data.stop_reason || '';
      if (missingIds.length) {
        console.warn(`[${category}] customer_sentiments mist ${missingIds.length}/${existingFmt.ids.length} id(s) (stop_reason: ${stopReason}): ${missingIds.join(', ')}`);
      }

      // Fase 4: per-opmerking classificatie cachen in KV, zodat een latere
      // fase filterwijzigingen kan her-aggregeren zonder nieuwe AI-aanroep.
      // Enkel "bestaande klanten" (customer_sentiments/topic_tags zijn per
      // opmerking-id) — prospecting blijft een categorie-brede synthese
      // zonder per-id structuur en valt hier dus nog buiten. Sleutel =
      // "key"/"sourceFile" die de client per opmerking meestuurt (zie
      // remarkCacheKey in app.js); de Worker vertrouwt die verder gewoon.
      const sentimentsById = new Map((toolUse.input?.existing_customers?.customer_sentiments || []).map((s) => [s.id, s]));
      const tagsById = new Map();
      for (const t of toolUse.input?.existing_customers?.topic_tags || []) {
        if (!tagsById.has(t.id)) tagsById.set(t.id, []);
        tagsById.get(t.id).push({ domain: t.domain, topic: t.topic, sentiment: t.sentiment, detail: t.detail, competitor: t.competitor || '' });
      }
      const categoryKey = LABEL_TO_KEY[category] || category;
      const cacheWrites = [];
      existing.remarks.forEach((r, i) => {
        if (!r.key || !r.sourceFile) return; // ontbrekende Fase 4-velden — niet cachen
        const id = existingFmt.ids[i];
        const sentimentEntry = sentimentsById.get(id);
        const record = {
          category: categoryKey,
          sourceFile: r.sourceFile,
          key: r.key,
          klant: r.name,
          rep: r.rep || '',
          regio: r.regio || '',
          date: r.date || '',
          type: r.type || '',
          status: r.status || '',
          remark: r.remark || '',
          sentiment: sentimentEntry ? sentimentEntry.sentiment : null,
          tags: tagsById.get(id) || [],
          storedAt: new Date().toISOString(),
        };
        // "metadata" (Fase 5) staat naast de waarde zelf en is via KV.list()
        // op te vragen zónder elke entry apart te moeten ophalen — zo kan
        // cached_options/cached_results (zie hieronder) op regio/rep/klant
        // filteren zonder duizenden losse KV.get()'s te doen.
        cacheWrites.push(
          env.FEEDBACKLOOP_KV.put(`remark:${r.sourceFile}:${categoryKey}:${r.key}`, JSON.stringify(record), {
            metadata: { category: categoryKey, sourceFile: r.sourceFile, klant: r.name, rep: r.rep || '', regio: r.regio || '' },
          })
        );
      });
      // Fase 4-bugfix: Promise.all zou bij de eerste mislukte put meteen
      // verwerpen en enkel die ene foutmelding loggen (console.warn, enkel
      // zichtbaar via "wrangler tail") — zonder dat de client ooit te zien
      // kreeg hoeveel writes er echt gelukt zijn. Promise.allSettled telt
      // gelukte/mislukte writes en geeft dat mee terug in de response, zodat
      // dit in de UI zichtbaar is i.p.v. enkel in Worker-logs.
      let cacheSucceeded = 0;
      let cacheFailed = 0;
      let cacheFirstError = '';
      if (cacheWrites.length) {
        const settled = await Promise.allSettled(cacheWrites);
        for (const s of settled) {
          if (s.status === 'fulfilled') {
            cacheSucceeded++;
          } else {
            cacheFailed++;
            if (!cacheFirstError) cacheFirstError = s.reason && s.reason.message ? s.reason.message : String(s.reason);
          }
        }
        if (cacheFailed) {
          console.warn(`[${category}] cache-schrijffout op ${cacheFailed}/${cacheWrites.length} entries: ${cacheFirstError}`);
        }
      }

      return jsonResponse({
        category,
        analysis: toolUse.input,
        cache: { attempted: cacheWrites.length, succeeded: cacheSucceeded, failed: cacheFailed, firstError: cacheFirstError },
        diagnostics: { stopReason, missingIds: missingIds.length, totalIds: existingFmt.ids.length },
      });
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
    '--- VERPLICHTE PER-OPMERKING CLASSIFICATIE (customer_sentiments) ---',
    'Geef als eerste veld "customer_sentiments" terug — geen samenvatting, maar een volledige en uitputtende lijst: exact één entry per genummerd opmerking-id hieronder bij "BESTAANDE KLANTEN" (elk id begint met "R", bv. "R1"), in dezelfde volgorde, zonder er één over te slaan en zonder ids te verzinnen. Doe dit VOORDAT je aan "topic_tags" en de verhalende velden begint (zie hieronder) — bij een lange opmerkingenlijst kan het antwoord de lengtelimiet raken, en deze lijst bepaalt rechtstreeks de score, dus mag nooit ontbreken.',
    `De ids die je moet gebruiken zijn: ${existingIds.join(', ') || '(geen)'}.`,
    'Ken per id exact één sentiment toe uit: "positive", "negative", "neutral", "no_opinion" — met deze betekenis:',
    '- "positive": de klant uit expliciete tevredenheid, lof, of wil de samenwerking duidelijk voortzetten/uitbreiden (bv. "zeer tevreden over levering", "wil graag opnieuw bestellen").',
    '- "negative": de klant uit een klacht, probleem, ontevredenheid, of overweegt/wil van leverancier wisselen (bv. "motor defect", "ontevreden over service", "klant twijfelt door slechte ervaring").',
    '- "neutral": een gemengd of louter feitelijk oordeel zonder duidelijke uitslag naar tevreden of ontevreden (bv. prijs/product vergeleken zonder waardeoordeel).',
    '- "no_opinion": zuiver administratieve notitie zonder enig oordeel over product/dienst (bv. "bezoek afgelegd", "staal afgegeven", "offerte besproken", "nog niet opgestart").',
    'Bij twijfel: een opgeloste klacht zonder verdere negatieve toon → "neutral" (niet "negative"); een aanhoudende/onopgeloste klacht → "negative"; een zuiver informatieve/administratieve zin zonder klantoordeel → "no_opinion" (niet "neutral").',
    'Deze lijst bepaalt rechtstreeks de betrouwbaarheidsscore in de tool — sla dus geen enkel id over, ook niet wanneer het overduidelijk "no_opinion" is.',
    '',
    '--- VASTE TAXONOMIE (topic_tags) ---',
    'In plaats van zelf thema\'s te verzinnen, classificeer je élke opmerking die een classificeerbaar aspect bevat met één of meer vaste tags uit onderstaande lijst (domein + onderwerp). Eén opmerking mag meerdere tags krijgen als ze meerdere aspecten bevat (bv. zowel een levertermijn-klacht als een prijsvergelijking). Opmerkingen die louter administratief zijn zonder enig classificeerbaar aspect (bv. "Bezoek afgelegd", "Stalen afgegeven") mogen 0 tags krijgen — verzin er niets bij.',
    buildTaxonomyBlock(),
    '',
    'Voor elke tag geef je: het opmerking-id (zie hieronder bij "BESTAANDE KLANTEN"), het domein, het onderwerp, een sentiment ("positive"/"negative"/"neutral" — t.o.v. DIT specifieke onderwerp, niet de klant in het algemeen), en een korte "detail"-tekst (max. 1 zin, concreet en specifiek — bv. "PVC levertermijn nu 8-10 weken i.p.v. gebruikelijke 5 weken", NIET "levertermijn is een probleem"). Bij onderwerp "prijsvergelijking" vermeld je in "competitor" de naam van de concurrent indien genoemd (leeg laten indien niet van toepassing).',
    'BELANGRIJK: verzin geen tag of "detail" die niet gedragen wordt door de tekst van de opmerking zelf. Geef nooit de klantnaam mee — het id volstaat, de tool vult de naam zelf aan. Gebruik nooit een domein/onderwerp buiten de vaste lijst hierboven.',
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

// ============================================================
// Auth (Fase 1: login & rollen) — users en sessies in Workers KV.
// ============================================================
//
// KV-keys:
//   user:<username>    -> { username, passwordHash, role }        (geen vervaldatum)
//   session:<token>    -> { username, role }                      (expirationTtl, zie hieronder)
//
// Wachtwoorden worden nooit leesbaar bewaard: sha256(wachtwoord + PASSWORD_PEPPER),
// PASSWORD_PEPPER is een Worker-secret (wrangler secret put PASSWORD_PEPPER),
// dus zelfs met leestoegang tot de KV-inhoud alleen kan een wachtwoord niet
// teruggerekend worden zonder ook die secret te kennen.

const SESSION_TTL_REMEMBER = 60 * 60 * 24 * 30; // 30 dagen ("blijf aangemeld")
const SESSION_TTL_DEFAULT = 60 * 60 * 12; // 12 uur

async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hashBuffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function getSession(request, env) {
  const token = request.headers.get('X-Auth-Token') || '';
  if (!token) return null;
  const raw = await env.FEEDBACKLOOP_KV.get(`session:${token}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function handleLogin(body, env) {
  const username = (body.username || '').trim();
  const password = body.password || '';
  const remember = !!body.remember;
  if (!username || !password) {
    return jsonResponse({ error: 'Gebruikersnaam en wachtwoord verplicht.' }, 400);
  }
  if (!env.PASSWORD_PEPPER) {
    return jsonResponse({ error: 'PASSWORD_PEPPER ontbreekt (wrangler secret put PASSWORD_PEPPER).' }, 500);
  }

  const userRaw = await env.FEEDBACKLOOP_KV.get(`user:${username}`);
  if (!userRaw) {
    return jsonResponse({ error: 'Onbekende gebruikersnaam of fout wachtwoord.' }, 401);
  }
  let user;
  try {
    user = JSON.parse(userRaw);
  } catch {
    return jsonResponse({ error: 'Onbekende gebruikersnaam of fout wachtwoord.' }, 401);
  }

  const hash = await sha256Hex(password + env.PASSWORD_PEPPER);
  if (hash !== user.passwordHash) {
    return jsonResponse({ error: 'Onbekende gebruikersnaam of fout wachtwoord.' }, 401);
  }

  const token = randomToken();
  const ttl = remember ? SESSION_TTL_REMEMBER : SESSION_TTL_DEFAULT;
  await env.FEEDBACKLOOP_KV.put(
    `session:${token}`,
    JSON.stringify({ username: user.username, role: user.role }),
    { expirationTtl: ttl }
  );
  return jsonResponse({ token, username: user.username, role: user.role });
}

async function handleLogout(request, env) {
  const token = request.headers.get('X-Auth-Token') || '';
  if (token) {
    await env.FEEDBACKLOOP_KV.delete(`session:${token}`);
  }
  return jsonResponse({ ok: true });
}

// Fase 2: admin laadt een Users-Excel op (kolommen USER/PW/ROLE, client-side
// al genormaliseerd naar {username, password, role}) om accounts toe te
// voegen of bij te werken zonder wrangler-commando's. Upsert per username:
// bestaande gebruikers die niet in het bestand voorkomen blijven ongewijzigd
// (geen volledige vervanging van alle user:* records in de KV).
async function handleAdminUpsertUsers(body, env) {
  if (!env.PASSWORD_PEPPER) {
    return jsonResponse({ error: 'PASSWORD_PEPPER ontbreekt (wrangler secret put PASSWORD_PEPPER).' }, 500);
  }
  const users = Array.isArray(body.users) ? body.users : [];
  if (!users.length) {
    return jsonResponse({ error: 'Geen gebruikers ontvangen.' }, 400);
  }

  let updated = 0;
  const errors = [];
  for (const raw of users) {
    const username = (raw.username || '').trim();
    const password = (raw.password || '').trim();
    const role = (raw.role || '').trim().toLowerCase();
    if (!username || !password) {
      errors.push(`${username || '(geen gebruikersnaam)'}: gebruikersnaam of wachtwoord ontbreekt — overgeslagen.`);
      continue;
    }
    if (role !== 'admin' && role !== 'user') {
      errors.push(`${username}: onbekende rol "${raw.role || ''}" (verwacht admin of user) — overgeslagen.`);
      continue;
    }
    try {
      const passwordHash = await sha256Hex(password + env.PASSWORD_PEPPER);
      await env.FEEDBACKLOOP_KV.put(`user:${username}`, JSON.stringify({ username, passwordHash, role }));
      updated++;
    } catch (err) {
      errors.push(`${username}: ${err.message}`);
    }
  }

  return jsonResponse({ updated, total: users.length, errors });
}

// Haalt ALLE keys met een gegeven prefix op (KV.list() geeft max. 1000 per
// aanroep terug, met een cursor voor de rest) en verwijdert ze. Gebruikt
// door zowel de per-bestand invalidatie (Fase 4) als de volledige
// cache-reset hieronder — enkel het verschil in prefix.
async function deleteByPrefix(kv, prefix) {
  let cursor;
  let deleted = 0;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const k of page.keys) {
      await kv.delete(k.name);
      deleted++;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return deleted;
}

// Fase 4: vóór een (her)analyse van de betrokken bestanden, worden hun
// eerder gecachete per-opmerking-entries gewist — zo vervangt een
// heropload met dezelfde bestandsnaam (bv. na een correctie) netjes de
// oude classificatie i.p.v. ernaast te blijven bestaan. Wordt door de
// client één keer aangeroepen vóór de volledige analyse-run start (niet
// per categorie/batch), zodat latere batches elkaars net geschreven
// entries voor hetzelfde bestand niet kunnen wegvegen.
async function handleCacheInvalidateFiles(body, env) {
  const files = Array.isArray(body.files) ? body.files.filter((f) => typeof f === 'string' && f) : [];
  if (!files.length) {
    return jsonResponse({ deleted: 0 });
  }
  let deleted = 0;
  for (const file of files) {
    deleted += await deleteByPrefix(env.FEEDBACKLOOP_KV, `remark:${file}:`);
  }
  return jsonResponse({ deleted });
}

// Wist de VOLLEDIGE analyse-cache (alle "remark:*"-entries) — niet de
// volledige KV-namespace: user:*/session:*-entries (login/rollen, Fase 1)
// blijven behouden, anders zou deze knop ook alle accounts en actieve
// sessies wissen. Bewuste aanpassing t.o.v. de oorspronkelijke afspraak
// ("reset knop wist de hele KV"), die dateert van vóór Fase 1 — toen zat
// er nog niets anders dan analyse-data in de KV.
async function handleCacheReset(env) {
  const deleted = await deleteByPrefix(env.FEEDBACKLOOP_KV, 'remark:');
  return jsonResponse({ deleted });
}

// Fase 5: geeft de distincte regio/rep/klant-waarden terug die momenteel in
// de cache zitten — hiermee kan de "user"-rol dezelfde 3 filters invullen
// als een admin, zonder ooit zelf iets opgeladen te hebben. Gebruikt de
// metadata die bij elke cache-entry werd meegeschreven (zie de
// KV.put(...,{metadata}) hierboven) i.p.v. elke entry apart op te halen —
// dat zou bij veel entries traag/duur worden.
async function handleCachedOptions(env) {
  const regios = new Set();
  const reps = new Set();
  const klanten = new Set();
  const regioCounts = {};
  let total = 0;
  let cursor;
  do {
    const page = await env.FEEDBACKLOOP_KV.list({ prefix: 'remark:', cursor });
    for (const k of page.keys) {
      total++;
      const m = k.metadata || {};
      if (m.regio) {
        regios.add(m.regio);
        regioCounts[m.regio] = (regioCounts[m.regio] || 0) + 1;
      }
      if (m.rep) reps.add(m.rep);
      if (m.klant) klanten.add(m.klant);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return jsonResponse({
    hasData: total > 0,
    total,
    regioCounts,
    regios: [...regios].sort((a, b) => a.localeCompare(b)),
    reps: [...reps].sort((a, b) => a.localeCompare(b)),
    klanten: [...klanten].sort((a, b) => a.localeCompare(b)),
  });
}

// Cap op het aantal gecachete opmerkingen dat in één keer volledig
// opgehaald (KV.get) wordt voor een cached_results-aanvraag. Elke KV.get()
// telt mee als een subrequest, en Cloudflare Workers laat daar per
// aanvraag maar een beperkt aantal van toe — deze waarde blijft daar ruim
// onder, met marge voor de list()-aanroepen erboven. Bij méér matches dan
// dit wordt het resultaat afgekapt (zie "truncated" in de response) en kan
// verder gefilterd worden (regio/rep/klant) om onder de grens te komen.
const CACHE_READ_LIMIT = 800;

// Fase 5: bouwt, ZONDER nieuwe AI-aanroep, per categorie een
// topic_tags/customer_sentiments/customers-set op uit de cache — exact de
// vorm die de bestaande render-functies in app.js al verwachten (zie
// renderResults/buildGlobalOverview/renderTopicDomains), enkel de
// verhalende AI-tekst (general_impression/benchmark_*/potential_summary)
// ontbreekt: die is nooit per opmerking gecached (Fase 4) en kan dus niet
// zonder AI-aanroep gereconstrueerd worden. Filtert eerst goedkoop via de
// KV-metadata (regio/rep/klant), en haalt pas voor de match(en) de
// volledige waarde op.
async function handleCachedResults(body, env) {
  const regioFilter = (body.regio || '').trim();
  const repFilter = (body.rep || '').trim();
  const klantFilter = (body.klant || '').trim();

  const matchingKeys = [];
  let total = 0;
  let cursor;
  do {
    const page = await env.FEEDBACKLOOP_KV.list({ prefix: 'remark:', cursor });
    for (const k of page.keys) {
      total++;
      const m = k.metadata || {};
      if (regioFilter && m.regio !== regioFilter) continue;
      if (repFilter && m.rep !== repFilter) continue;
      if (klantFilter && m.klant !== klantFilter) continue;
      matchingKeys.push(k.name);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const cappedKeys = matchingKeys.slice(0, CACHE_READ_LIMIT);
  const records = await Promise.all(cappedKeys.map((name) => env.FEEDBACKLOOP_KV.get(name, 'json')));

  const categories = {};
  for (const cat of CATEGORY_KEYS) {
    categories[cat] = { customers: [], topic_tags: [], customer_sentiments: [] };
  }
  for (const rec of records) {
    if (!rec || !categories[rec.category]) continue;
    const bucket = categories[rec.category];
    bucket.customers.push({ name: rec.klant, remark: rec.remark, rep: rec.rep, date: rec.date, type: rec.type, status: rec.status });
    bucket.customer_sentiments.push({ customer: rec.klant, sentiment: rec.sentiment });
    for (const t of rec.tags || []) {
      bucket.topic_tags.push({ customer: rec.klant, domain: t.domain, topic: t.topic, sentiment: t.sentiment, detail: t.detail, competitor: t.competitor || '' });
    }
  }

  return jsonResponse({
    categories,
    total,
    matched: matchingKeys.length,
    truncated: matchingKeys.length > cappedKeys.length,
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Auth-Token',
  };
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders() },
  });
}
