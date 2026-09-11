/* Winsol Feedbackloop — client-side logic
 * 1) Parse uploaded CRM-export (xlsx/xls/csv, incl. legacy SpreadsheetML .xls)
 * 2) Stap 1 "Filteren": bouw twee filters op uit de data (Sales Rep = kolom
 *    Q, Klant = kolom B) en laat de gebruiker optioneel één waarde per
 *    filter kiezen. Een rij moet aan BEIDE voldoen (EN) om mee te tellen —
 *    zie matchesFilters/getFilteredRows.
 * 3) Stap 2 "Analyseren", enkel op de gefilterde rijen:
 *    a) Classify each row into Screens / Shutters / Fusion / Luifels /
 *       Pergola / Outdoor / Home + bestaande klant vs. prospect
 *    b) Reken de harde cijfers lokaal uit (aantallen, potentieel in €, wie
 *       de klanten zijn) — dat gaat dus nooit "gokken"
 *    c) Stuur enkel de samengevatte cijfers + klantnamen + opmerkingen naar
 *       de Worker (worker.js), die Claude vraagt om de kwalitatieve synthese
 * 4) Render het resultaat, met per thema/probleem/wens/drempel uitklapbaar
 *    wélke klanten erachter zitten (en klikbaar door naar de brondata)
 *
 * Categorisering: de CRM-kolommen "Vertical shading" en "Luifels" geven een
 * hint (indien ingevuld), maar zijn in de praktijk vaak leeg. Daarom wordt
 * voor élke rij ook de vrije tekst (Remark, kolom M — plus Re/Reason)
 * doorzocht op trefwoorden (KEYWORDS hieronder) om af te leiden over welk
 * product het gaat — dat is de enige bron voor Pergola, en de fallback voor
 * de andere categorieën. Pas de trefwoordenlijsten hier gerust aan.
 *
 * Eén opmerking kan tekst over meerdere categorieën bevatten (bv. een
 * bezoekrapport dat zowel over Screens als over een Pergola-project gaat).
 * De rij telt dan terecht mee in de harde cijfers van beide categorieën.
 * Maar om te vermijden dat de AI, bij het analyseren van bv. Screens, ook
 * de Pergola-zinnen in diezelfde opmerking oppikt ("lekkage" tussen
 * categorieën), wordt de tekst die naar de AI gaat eerst per categorie
 * gefilterd: zinnen/fragmenten die duidelijk over een ándere categorie gaan
 * worden weggelaten (zie filterRemarkForCategory). De harde cijfers zelf
 * blijven ongemoeid — enkel de AI-input wordt gefilterd.
 */

const CATEGORY_LABELS = {
  screens: 'Screens',
  shutters: 'Rolluiken',
  fusion: 'Fusion',
  awnings: 'Luifels',
  pergola: "Pergola",
  outdoor: 'Outdoor',
  home: 'Home',
};

// Bron van waarheid: CATEGORIE_TREFWOORDEN.xlsx (in de werkmap naast deze
// repo) — Gwenn's eigen lijst van merk-/productnamen per categorie, met
// enkele algemene trefwoorden erbovenop. Dat bestand is de plek om dit uit
// te breiden (nieuwe rij bijvoegen); geef door welke rijen toegevoegd zijn
// en ik neem ze hier over. De brondata-kolommen staan in de praktijk zo
// goed als altijd leeg, dus dit is de hoofdbron, niet enkel een fallback.
const KEYWORDS = {
  screens: [
    'SolFix', 'SolarFix', 'Solscreen', 'ClimaFix',
    'screen', 'screens', 'zonnescherm', 'zonneschermen',
  ],
  shutters: [
    'Voorzet', 'opbouw rolluik', 'SolarBox', 'inbouw rolluik', 'ClimaBox',
    'rolluik', 'rolluiken', 'shutter', 'shutters', 'volet', 'volets',
  ],
  fusion: [
    'Fusion', 'Fuison', 'SolarFuse',
  ],
  awnings: [
    'lumisol', 'linasol', 'Luno', 'squaro', 'C1200', 'C2500', 'C550', 'loft', 'combisol', 'acryl (doek)',
    'store banne', 'luifel', 'luifels', 'tent', 'knikarm', 'knikarmscherm',
    'markies', 'markiezen', 'awning', 'awnings',
    // powerbandarm(en)/powerband: onderdeel van een luifel (motor-/
    // draagarm) — "powerband" nu ook toegevoegd in CATEGORIE_TREFWOORDEN.xlsx;
    // "powerbandarm(en)" blijft ernaast staan, want door de woordgrens
    // matcht "powerband" alleen niet met de vorm "powerbandarmen" die in de
    // echte remarks voorkomt (zelfde soort gat als lamel/lamellen).
    // 4-kabel/2-kabel: geleidingssysteem-varianten, uit CATEGORIE_TREFWOORDEN.xlsx.
    'powerbandarm', 'powerbandarmen', 'powerband', '4-kabel', '2-kabel',
  ],
  pergola: [
    "SO!", 'L!V', 'Origin', "Orig!n", 'Z!P', 'Z!P Cube',
    'lamellendak', 'lamel', 'pergola', "pergola's",
    // Meervoud/typografische varianten die in de echte remarks voorkomen
    // maar niet matchten door de strikte woordgrens: "lamellen" (meervoud
    // van "lamel" — het enkelvoud komt in de praktijk nooit los voor) en
    // "ZIP" zonder "!" (in 500 rijen: 34x "ZIP", 0x het letterlijke "Z!P").
    // Dit was de eigenlijke oorzaak van de Pergola-content die nog bij
    // Screens verscheen: die zinnen werden niet herkend als "over Pergola",
    // en golden daardoor als neutrale/algemene tekst die overal bleef staan.
    'lamellen', 'ZIP',
  ],
  outdoor: [
    'Verandasol', 'Wincube', 'Alubox',
    // Uit CATEGORIE_TREFWOORDEN.xlsx (aangevuld door Gwenn).
    'veranda', 'serre', 'uitvalscherm',
  ],
  home: [
    'Iqon', 'PVC', 'Allura', 'Artica', 'steellook', 'Aurora', 'Imperia', 'Qubic', 'Centriq', 'Retro & retrolux', 'Moov',
    'schrijnwerk', 'raam', 'ramen', 'deur', 'deuren', 'poort', 'poorten', 'kozijn', 'kozijnen',
  ],
};

// Kolom-hints: dekt zowel de kolomnamen uit oudere exports als de huidige
// (Windows/Outdoor/Shutter/Screens/Garage/Awnings) — worden gebruikt als ze
// toevallig wél ingevuld zijn, bovenop de trefwoorden hierboven.
const COLUMN_HINTS = {
  luifels: 'awnings', awnings: 'awnings',
  home: 'home', windows: 'home', garage: 'home',
  shutter: 'shutters',
  screens: 'screens',
  outdoor: 'outdoor',
};

// Bron-kolom om het potentieel (€) van een categorie uit te lezen, met
// generieke "Potential"-kolom als fallback.
const POTENTIAL_COLUMN = {
  screens: 'vertical shading',
  shutters: 'vertical shading',
  fusion: null,
  awnings: 'luifels',
  pergola: null,
  outdoor: 'outdoor',
  home: 'home',
};

// Eigen woordgrens i.p.v. \b: trefwoorden als "SO!" of "Z!P" bevatten
// leestekens waar \b niet correct mee omgaat (geen grens tussen "!" en een
// spatie). Voorkomt zowel gemiste matches (SO! met spatie erna) als valse
// treffers middenin een ander woord (bv. "so" in "persoon").
function matchesKeyword(text, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i').test(text);
}

// "SO" (zonder "!") is dubbelzinniger dan "SO!" — in hoofdletters (SO) is
// het vrijwel altijd het merk en telt het direct mee voor Pergola; in
// kleine letters ("so") is het een courant los woord, dus die telt enkel
// mee als "pergola" ook ergens in dezelfde tekst voorkomt (ter bevestiging).
function matchesBareSO(text) {
  if (/(^|[^a-zA-Z0-9])SO($|[^a-zA-Z0-9])/.test(text)) return true;
  return matchesKeyword(text, 'so') && matchesKeyword(text, 'pergola');
}

// Welke categorieën komen voor in een los stukje tekst (op basis van de
// trefwoorden) — gedeeld door classifyCategories (hele rij) en
// filterRemarkForCategory (per zin, voor de AI-input).
function categoriesInText(text) {
  const cats = new Set();
  for (const cat of Object.keys(KEYWORDS)) {
    if (KEYWORDS[cat].some((w) => matchesKeyword(text, w))) cats.add(cat);
  }
  if (matchesBareSO(text)) cats.add('pergola');
  return cats;
}

const POTENTIAL_MIDPOINTS = {
  '0-50k': 25000, '50-100k': 75000, '100-150k': 125000,
  '150-500k': 325000, '500k-1m': 750000,
};

// Max. aantal opmerkingen per categorie/deel dat naar de AI gaat voor de
// kwalitatieve synthese (kost/prompt-grootte begrenzen). Telt niet mee voor
// de harde cijfers (aantallen, potentieel) — die gebruiken altijd alle rijen.
// Met 7 categorieën x 2 delen kan dit snel oplopen (een rij kan nu in
// meerdere categorieën tegelijk vallen); te hoog gaf een 502 (prompt te
// groot/te traag). 60 blijft ruim voldoende om terugkerende thema's te
// herkennen.
const MAX_REMARKS_TO_AI = 60;

let parsedRows = [];
// Laatst opgebouwde aggregatie (met volledige rij-detail per klant) —
// bewaard zodat de klik-op-klantnaam-popup (openCustomerModal) er nadien
// nog bij kan, buiten de scope van de analyze-click-handler.
let lastAgg = null;

// URL van de losstaande Cloudflare Worker (zie worker.js).
const ANALYZE_URL = 'https://feedbackloop.gwenn-vanthournout.workers.dev/';

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const fname = document.getElementById('fname');
const filterBtn = document.getElementById('filterBtn');
const filterCard = document.getElementById('filterCard');
const filterRep = document.getElementById('filterRep');
const filterKlant = document.getElementById('filterKlant');
const filterKlantList = document.getElementById('filterKlantList');
const filterStatus = document.getElementById('filterStatus');
const analyzeBtn = document.getElementById('analyzeBtn');
const statusText = document.getElementById('statusText');

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', (e) => {
  if (e.target.files[0]) handleFile(e.target.files[0]);
});

function handleFile(file) {
  fname.textContent = file.name;
  setStatus('Bestand inlezen...');
  // Nieuw bestand: stap 1 (filter) moet opnieuw doorlopen worden voor er
  // geanalyseerd kan worden — dat voorkomt dat een oude filterselectie
  // (klant/rep uit een vorig bestand) stilzwijgend blijft hangen.
  filterCard.hidden = true;
  filterBtn.disabled = true;
  analyzeBtn.disabled = true;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      parsedRows = normalizeRows(rows);
      setStatus(`${parsedRows.length} rijen ingelezen uit "${wb.SheetNames[0]}". Klik op "Filteren" om verder te gaan.`);
      filterBtn.disabled = parsedRows.length === 0;
    } catch (err) {
      setStatus('Kon het bestand niet lezen: ' + err.message, true);
      filterBtn.disabled = true;
    }
  };
  reader.readAsArrayBuffer(file);
}

// Stap 1 — Filteren: bouwt de twee filters op uit de ingelezen data (Sales
// Rep = kolom Q, Klant = kolom B) en toont de filterkaart. De analyse zelf
// (stap 2) gebeurt pas na een klik op "Analyseren", met de dan geldende
// filterselectie.
filterBtn.addEventListener('click', () => {
  const reps = [...new Set(parsedRows.map((r) => r['rep']).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const klanten = [...new Set(parsedRows.map((r) => r['name']).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  filterRep.innerHTML = '<option value="">Alle</option>' + reps.map((r) => `<option value="${escapeAttr(r)}">${escapeHtml(r)}</option>`).join('');
  filterKlantList.innerHTML = klanten.map((k) => `<option value="${escapeAttr(k)}"></option>`).join('');
  filterKlant.value = '';

  filterCard.hidden = false;
  updateFilterStatus();
  setStatus(`${parsedRows.length} rijen ingelezen. Kies eventueel een filter en klik op "Analyseren".`);
});

filterRep.addEventListener('change', updateFilterStatus);
filterKlant.addEventListener('input', updateFilterStatus);

// Rij voldoet aan filter1 (Sales Rep) EN filter2 (Klant) — een leeg filter
// ("Alle") legt geen voorwaarde op. Klant is een vrij tekstveld (met
// datalist-suggesties) maar moet, om als filter te gelden, exact overeen-
// komen met een klantnaam uit de data — anders levert dat gewoon 0 rijen
// op, zichtbaar via de live teller hieronder.
function matchesFilters(row) {
  const repVal = filterRep.value;
  const klantVal = filterKlant.value.trim();
  if (repVal && row['rep'] !== repVal) return false;
  if (klantVal && row['name'] !== klantVal) return false;
  return true;
}

function getFilteredRows() {
  return parsedRows.filter(matchesFilters);
}

function updateFilterStatus() {
  const n = getFilteredRows().length;
  filterStatus.textContent = `${n} van ${parsedRows.length} rapporten voldoen aan deze filters.`;
  filterStatus.className = 'status' + (n === 0 ? ' err' : '');
  analyzeBtn.disabled = n === 0;
}

function normalizeRows(rows) {
  return rows.map((r) => {
    const norm = {};
    for (const k in r) norm[k.trim().toLowerCase()] = String(r[k] ?? '').trim();
    return norm;
  });
}

function setStatus(msg, isErr) {
  statusText.textContent = msg;
  statusText.className = 'status' + (isErr ? ' err' : '');
}

function parsePotential(str) {
  if (!str) return 0;
  const key = str.toLowerCase().replace(/\s/g, '');
  return POTENTIAL_MIDPOINTS[key] || 0;
}

// Categorie-kolom (bv. "Home") bevat niet altijd een herkenbare €-range
// (soms gewoon de letterlijke tekst "Home") — val dan terug op de
// generieke "Potential"-kolom in plaats van stil 0 te tellen.
function potentialForCategory(row, cat) {
  const col = POTENTIAL_COLUMN[cat];
  if (col) {
    const val = parsePotential(row[col]);
    if (val) return val;
  }
  return parsePotential(row['potential']);
}

function classifyCategories(row) {
  const cats = new Set();
  const text = [row['remark'], row['re'], row['reason']].join(' ');

  // Kolom-hints, indien toevallig ingevuld.
  for (const col in COLUMN_HINTS) {
    if (row[col]) cats.add(COLUMN_HINTS[col]);
  }
  if (row['vertical shading']) {
    cats.add(matchesKeyword(text, 'rolluik') || matchesKeyword(text, 'shutter') ? 'shutters' : 'screens');
  }

  // Trefwoorden in de vrije tekst — hoofdbron (zie comment bij KEYWORDS).
  for (const c of categoriesInText(text)) cats.add(c);

  return [...cats];
}

function isExisting(row) {
  const status = (row['status'] || '').toLowerCase();
  if (status.includes('active customer')) return true;
  if (status.includes('to be contacted') || status.includes('not to be contacted')) return false;
  const reason = (row['reason'] || '').toLowerCase();
  if (reason.includes('prospect') || reason.includes('follow up visit to potential')) return false;
  return true;
}

function buildAggregation(rows) {
  const cats = Object.keys(CATEGORY_LABELS);
  const agg = {};
  for (const cat of cats) {
    agg[cat] = {
      existing: { customers: [] },
      prospecting: { customers: [], potentialSum: 0 },
    };
  }
  for (const row of rows) {
    const rowCats = classifyCategories(row);
    const existing = isExisting(row);
    const name = row['name'] || '(naam onbekend)';
    const remark = [row['remark'], row['re']].filter(Boolean).join(' — ');
    // Bewaar genoeg van de brondata om nadien (bij het aanklikken van een
    // klantnaam) de originele rij te kunnen tonen — zie openCustomerModal.
    // "Rep" is de vertegenwoordiger; "User" als terugval indien leeg.
    const detail = {
      name,
      remark,
      rep: row['rep'] || row['user'] || '',
      date: row['date'] || '',
      type: row['type'] || '',
      status: row['status'] || '',
    };
    for (const cat of rowCats) {
      if (existing) {
        agg[cat].existing.customers.push(detail);
      } else {
        agg[cat].prospecting.customers.push(detail);
        agg[cat].prospecting.potentialSum += potentialForCategory(row, cat);
      }
    }
  }
  return agg;
}

// Splitst een opmerking in losse fragmenten, zodat filterRemarkForCategory
// per fragment kan beoordelen of het over de gevraagde categorie gaat.
// Bewust NIET splitsen op "!" of "?": een aantal merknamen bevatten een "!"
// (SO!, Z!P, Orig!n) en dat zou die stukmaken. We splitsen op:
//  - een punt/puntkomma gevolgd door witruimte ("Tevreden. Wil ook...")
//  - nieuwe regels
//  - een lang streepje tussen spaties ("—"), want dat is precies het teken
//    waarmee de Remark- en Re-kolom hierboven samengevoegd worden — vaak
//    exact de plek waar twee verschillende onderwerpen samenkomen.
function splitSentences(text) {
  return text
    .split(/(?<=[.;])\s+|\n+|\s+—\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Filtert een opmerking voor een specifieke categorie: fragmenten die
// duidelijk (enkel) over een ándere categorie gaan worden weggelaten, zodat
// die inhoud niet "lekt" naar de AI-analyse van deze categorie. Fragmenten
// zonder herkenbaar categorie-trefwoord (algemene zinnen als "goed
// tevreden") blijven altijd staan. Als er niets overblijft na filtering,
// wordt de opmerking niet meegestuurd voor déze categorie (de klant blijft
// wel gewoon meetellen in de harde cijfers, via classifyCategories).
function filterRemarkForCategory(remark, targetCat) {
  if (!remark) return remark;
  // Geen "als er toch maar 1 fragment is, stuur dan alles door"-kortsluiting
  // meer: ook een opmerking zónder splitsbare punctuatie (bv. één enkele
  // zin met alleen een komma, "Terugkerend lawaaiprobleem aan lamellen, X
  // interventies") moet gewoon tegen het trefwoordenfilter aangehouden
  // worden. Zonder deze check liep zo'n volledig off-topic opmerking
  // ongefilterd door naar elke categorie waarin de rij toevallig óók zat
  // (bv. via een ingevulde kolom) — dat was de oorzaak van Pergola-content
  // (lamellen) die nog bij Screens verscheen.
  const segments = splitSentences(remark);
  const kept = segments.filter((seg) => {
    const segCats = categoriesInText(seg);
    return segCats.size === 0 || segCats.has(targetCat);
  });
  return kept.join(' ');
}

// Beperkte remarks-lijst (met klantnaam) om naar de AI te sturen — enkel
// klanten die ook effectief iets geschreven hebben dat (na filtering) over
// déze categorie gaat.
function remarksForAi(customers, targetCat) {
  const filtered = customers
    .map((c) => ({ name: c.name, remark: filterRemarkForCategory(c.remark, targetCat) }))
    .filter((c) => c.remark);
  return filtered.slice(0, MAX_REMARKS_TO_AI);
}

document.getElementById('analyzeBtn').addEventListener('click', async () => {
  analyzeBtn.disabled = true;
  setStatus('Data structureren...');
  const filteredRows = getFilteredRows();
  const agg = buildAggregation(filteredRows);
  lastAgg = agg;
  const cats = Object.keys(CATEGORY_LABELS);
  showProgress(0, cats.length);

  // Eén (kleine, snelle) AI-aanroep per categorie, parallel — dat geeft
  // een écht voortgangspunt (x van y klaar) in plaats van een nagebootste
  // balk, en houdt elke aanroep klein genoeg om betrouwbaar te blijven.
  let done = 0;
  const results = await Promise.all(cats.map(async (cat) => {
    const v = agg[cat];
    try {
      const res = await fetch(ANALYZE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: CATEGORY_LABELS[cat],
          existing: { remarks: remarksForAi(v.existing.customers, cat) },
          prospecting: { remarks: remarksForAi(v.prospecting.customers, cat), potentialSum: v.prospecting.potentialSum },
        }),
      });
      if (!res.ok) {
        let detail = '';
        try {
          const errBody = await res.json();
          detail = errBody.error || '';
        } catch {
          // response was not JSON (bv. een Cloudflare-foutpagina) — geen detail beschikbaar
        }
        throw new Error(`status ${res.status}${detail ? ' — ' + detail : ''}`);
      }
      const data = await res.json();
      return [cat, data.analysis, null];
    } catch (err) {
      return [cat, null, err.message];
    } finally {
      done++;
      showProgress(done, cats.length);
    }
  }));

  const aiCategories = {};
  const failed = [];
  for (const [cat, analysis, err] of results) {
    if (analysis) aiCategories[cat] = analysis;
    else failed.push(`${CATEGORY_LABELS[cat]} (${err})`);
  }

  renderResults(agg, aiCategories);
  hideProgress();
  const filterNote = filteredRows.length === parsedRows.length
    ? `${parsedRows.length} rijen`
    : `${filteredRows.length} van ${parsedRows.length} rijen (filter: ${filterRep.value || 'alle reps'} / ${filterKlant.value || 'alle klanten'})`;
  if (failed.length) {
    setStatus(`Analyse deels mislukt voor: ${failed.join(', ')}. De andere categorieën zijn wel bijgewerkt.`, true);
  } else {
    setStatus(`Analyse voltooid op basis van ${filterNote}.`);
  }
  analyzeBtn.disabled = false;
});

function showProgress(done, total) {
  const bar = document.getElementById('progressBar');
  const fill = document.getElementById('progressFill');
  bar.hidden = false;
  fill.style.width = Math.round((done / total) * 100) + '%';
  setStatus(`AI-analyse loopt: ${done}/${total} categorieën verwerkt...`);
}

function hideProgress() {
  document.getElementById('progressBar').hidden = true;
}

function renderResults(agg, aiCategories) {
  const tabsEl = document.getElementById('tabs');
  const sectionsEl = document.getElementById('sections');
  tabsEl.innerHTML = '';
  sectionsEl.innerHTML = '';
  const cats = Object.keys(CATEGORY_LABELS);

  cats.forEach((cat, i) => {
    const tab = document.createElement('div');
    tab.className = 'tab' + (i === 0 ? ' active' : '');
    tab.textContent = CATEGORY_LABELS[cat];
    tab.onclick = () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.section').forEach((s) => s.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('section-' + cat).classList.add('active');
    };
    tabsEl.appendChild(tab);

    const section = document.createElement('div');
    section.className = 'section' + (i === 0 ? ' active' : '');
    section.id = 'section-' + cat;
    const stats = agg[cat];
    const ai = (aiCategories && aiCategories[cat]) || {};
    const existingAi = ai.existing_customers || {};
    const prospAi = ai.prospecting || {};

    section.innerHTML = `
      <div class="card">
        <h2 class="part-title">Deel 1 — Bestaande klanten</h2>
        <p class="part-sub">${CATEGORY_LABELS[cat]} · gebaseerd op ${stats.existing.customers.length} rapporten</p>
        <div class="stat-row">
          <div class="stat"><b>${stats.existing.customers.length}</b><span>bestaande klanten met input</span></div>
        </div>
        ${renderCustomerList(stats.existing.customers, 'Bekijk welke klanten', cat, 'existing')}
        <p class="narrative">${escapeHtml(existingAi.general_impression || 'Geen data beschikbaar.')}</p>
        ${renderThemes(existingAi.themes, cat, 'existing')}
        <h2 class="part-title" style="margin-top:18px;">Technische meldingen</h2>
        ${renderIssueGroups(existingAi.technical_issues, 'issue', 'probleem', cat, 'existing')}
        <h2 class="part-title" style="margin-top:18px;">Gewenste features</h2>
        ${renderIssueGroups(existingAi.feature_requests, 'request', 'wens', cat, 'existing')}
        <h2 class="part-title" style="margin-top:18px;">Benchmark product</h2>
        <p class="narrative">${escapeHtml(existingAi.benchmark_product || '—')}</p>
        <h2 class="part-title" style="margin-top:18px;">Benchmark prijs</h2>
        <p class="narrative">${escapeHtml(existingAi.benchmark_price || '—')}</p>
      </div>
      <div class="card">
        <h2 class="part-title">Deel 2 — Prospecting</h2>
        <p class="part-sub">${CATEGORY_LABELS[cat]} · gebaseerd op ${stats.prospecting.customers.length} rapporten</p>
        <div class="stat-row">
          <div class="stat"><b>${stats.prospecting.customers.length}</b><span>prospects</span></div>
          <div class="stat"><b>&euro;${Math.round(stats.prospecting.potentialSum).toLocaleString('nl-BE')}</b><span>totaal potentieel (schatting)</span></div>
        </div>
        ${renderCustomerList(stats.prospecting.customers, 'Bekijk welke prospects', cat, 'prospecting')}
        <p class="narrative">${escapeHtml(prospAi.potential_summary || 'Geen data beschikbaar.')}</p>
        <h2 class="part-title" style="margin-top:18px;">Drempels om over te stappen</h2>
        ${renderThemes(prospAi.barriers, cat, 'prospecting')}
      </div>
    `;
    sectionsEl.appendChild(section);
  });

  document.getElementById('results').style.display = 'block';
}

// escapeHtml (hieronder) gaat via div.textContent/innerHTML — dat escaped
// &, < en > correct voor tekstinhoud, maar NIET aanhalingstekens (die zijn
// enkel relevant binnen een HTML-attribuut, niet in tekstinhoud). Voor de
// data-* attributen hieronder (klantnaam kan een " of ' bevatten) is dat
// wél nodig, anders breekt het attribuut. Vandaar een aparte helper.
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// Eén klikbare klantnaam — opent de brondata-popup (openCustomerModal) via
// het gedelegeerde click-event hieronder. data-cat/data-part/data-name
// zijn de sleutel om in lastAgg de bijbehorende rij(en) terug te vinden.
function customerLinkHtml(name, cat, part) {
  return `<button type="button" class="customer-link" data-cat="${escapeAttr(cat)}" data-part="${escapeAttr(part)}" data-name="${escapeAttr(name)}">${escapeHtml(name)}</button>`;
}

function renderCustomerList(customers, label, cat, part) {
  if (!customers.length) return '';
  const items = customers.map((c) => `<li>${customerLinkHtml(c.name, cat, part)}${c.remark ? ' — ' + escapeHtml(truncate(c.remark, 90)) : ''}</li>`).join('');
  return `<details class="customers-list"><summary>${label} (${customers.length})</summary><ul class="customer-names">${items}</ul></details>`;
}

// Eén uitklapbaar blokje (thema/probleem/wens/drempel) met de klantnamen
// erachter en een badge (sentiment-pill of vast label) rechts. Elke
// klantnaam is klikbaar (zie customerLinkHtml) zodat je de brondata kan
// controleren waarop de analyse gebaseerd is.
function renderDetailsBlock(label, names, badgeHtml, cat, part) {
  const inner = names.length
    ? `<div class="customer-list">${names.map((n) => `<div>${customerLinkHtml(n, cat, part)}</div>`).join('')}</div>`
    : '';
  return `
    <details class="theme-details">
      <summary>
        <span class="theme-label">${escapeHtml(label || '')}</span>
        <span class="theme-badges">${badgeHtml} <span class="count-badge">${names.length}</span></span>
      </summary>
      ${inner}
    </details>
  `;
}

function renderThemes(themes, cat, part) {
  if (!themes || !themes.length) return '<p class="narrative">—</p>';
  return themes.map((t) => {
    const names = t.customers || [];
    const sentiment = t.sentiment || 'neutral';
    return renderDetailsBlock(t.label, names, `<span class="pill ${sentiment}">${sentiment}</span>`, cat, part);
  }).join('');
}

// Technische meldingen / gewenste features: zelfde uitklap-opmaak als
// renderThemes, maar met een vast badge-label i.p.v. sentiment (positief/
// negatief zegt hier niets — het gaat om "is dit gemeld", niet om toon).
function renderIssueGroups(items, badgeClass, badgeText, cat, part) {
  if (!items || !items.length) return '<p class="narrative">Geen gemeld.</p>';
  return items.map((t) => {
    const names = t.customers || [];
    return renderDetailsBlock(t.label, names, `<span class="pill ${badgeClass}">${badgeText}</span>`, cat, part);
  }).join('');
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n) + '…' : str;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}

/* --- Klantnaam-popup: toont de originele CRM-rij(en) waarop een thema/
 * probleem/wens/drempel gebaseerd is, zodat je kan nagaan of de
 * categorie-classificatie/filtering klopt. Eén klantnaam kan met meerdere
 * rijen (bezoekrapporten) overeenkomen binnen dezelfde categorie/deel — die
 * worden dan allemaal getoond. */
const customerModal = document.getElementById('customerModal');
const modalBody = document.getElementById('modalBody');

document.addEventListener('click', (e) => {
  const link = e.target.closest('.customer-link');
  if (link) {
    openCustomerModal(link.dataset.cat, link.dataset.part, link.dataset.name);
    return;
  }
  if (e.target.closest('#modalClose') || e.target === customerModal) {
    closeCustomerModal();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !customerModal.hidden) closeCustomerModal();
});

function openCustomerModal(cat, part, name) {
  const bucket = lastAgg && lastAgg[cat] && lastAgg[cat][part];
  const entries = bucket ? bucket.customers.filter((c) => c.name === name) : [];

  const visits = entries.length
    ? entries.map((v) => `
        <div class="modal-visit">
          <div class="modal-field"><b>Vertegenwoordiger</b><span>${escapeHtml(v.rep || '—')}</span></div>
          <div class="modal-field"><b>Datum bezoek</b><span>${escapeHtml(v.date || '—')}</span></div>
          <div class="modal-field"><b>Type bezoek</b><span>${escapeHtml(v.type || '—')}</span></div>
          <div class="modal-field"><b>Status</b><span>${escapeHtml(v.status || '—')}</span></div>
          <div class="modal-field modal-field-full"><b>Inhoud van het bezoek</b><p class="narrative">${escapeHtml(v.remark || '—')}</p></div>
        </div>
      `).join('')
    : '<p class="narrative">Geen brondata gevonden voor deze klant in deze categorie/dit deel.</p>';

  modalBody.innerHTML = `
    <h3 class="modal-title">${escapeHtml(name)}</h3>
    <p class="part-sub">${CATEGORY_LABELS[cat] || cat} · ${part === 'prospecting' ? 'Prospecting' : 'Bestaande klant'} · ${entries.length} bezoekrapport${entries.length === 1 ? '' : 'en'}</p>
    ${visits}
  `;
  customerModal.hidden = false;
}

function closeCustomerModal() {
  customerModal.hidden = true;
  modalBody.innerHTML = '';
}
