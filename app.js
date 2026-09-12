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
    'lamellendak', 'pergola', "pergola's",
    // "lamel" (enkelvoud) bewust NIET als trefwoord: dat woord wordt ook
    // gebruikt voor lamellen van een rolluik, en zou dan onterecht als
    // Pergola-content herkend worden. "lamellen" (meervoud) hieronder is
    // in de praktijk wel specifiek genoeg voor het lamellendak van een
    // pergola (bevestigd door Gwenn, zie CATEGORIE_TREFWOORDEN.xlsx).
    //
    // Meervoud/typografische varianten die in de echte remarks voorkomen
    // maar niet matchten door de strikte woordgrens: "lamellen" en "ZIP"
    // zonder "!" (in 500 rijen: 34x "ZIP", 0x het letterlijke "Z!P"). Dit
    // was de eigenlijke oorzaak van Pergola-content die nog bij Screens
    // verscheen: die zinnen werden niet herkend als "over Pergola", en
    // golden daardoor als neutrale/algemene tekst die overal bleef staan.
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

// Batchgrootte: max. aantal opmerkingen per AI-aanroep (kost/prompt-grootte
// begrenzen — te hoog gaf een 502, prompt te groot/te traag). Een categorie
// met meer bruikbare opmerkingen dan dit wordt in meerdere batches
// verdeeld die parallel naar de AI gaan en nadien samengevoegd worden
// (zie analyzeCategory) — zo gaat geen enkele klant verloren, ook niet bij
// grote gecombineerde datasets (meerdere Excel-bestanden).
const BATCH_SIZE = 60;

// Vaste taxonomie (domein + onderwerp) waarmee de AI elke opmerking
// classificeert i.p.v. zelf vrije "themes" te verzinnen — zie worker.js
// (TOPIC_TAXONOMY, daar losstaand gedefinieerd want de Worker en de
// frontend draaien apart; bij een wijziging hier dus ook worker.js
// aanpassen). Gebaseerd op analyse van 6 maanden echte data (zie de
// taxonomie-discussie): bezoekrapporten gaan overwegend over de
// dealerrelatie (leads, prijs, marketing), met R&D-relevante
// productsignalen als kleinere, verspreide minderheid — vandaar de
// aparte domeinen i.p.v. alles even zwaar als "thema" te tonen.
const TAXONOMY = {
  product_techniek: {
    label: 'Product & Techniek',
    topics: {
      onderdeel_defect: 'Onderdeel-/kwaliteitsprobleem',
      bediening_domotica: 'Bediening/motorisatie/domotica',
      kleur_afwerking: 'Kleur/afwerking',
      maatvoering_beperking: 'Maatvoering/technische beperking',
      feature_wens: 'Ontbrekende functionaliteit/productwens',
    },
  },
  levering_logistiek: {
    label: 'Levering & Logistiek',
    topics: {
      levertermijn: 'Levertermijn te lang',
      foutieve_levering: 'Onvolledige/foutieve levering',
      transportplanning: 'Transportplanning',
    },
  },
  service_herstelling: {
    label: 'Service & Herstelling',
    topics: {
      sav_opvolging: 'SAV-opvolging/reactietijd',
      herstelling_garantie: 'Herstelling/garantie/creditnota',
    },
  },
  prijs_concurrentie: {
    label: 'Prijs & Concurrentiepositie',
    topics: {
      prijsvergelijking: 'Prijsvergelijking met concurrent',
      marge_korting: 'Marge-/kortingsdiscussie',
    },
  },
  tools_ondersteuning: {
    label: 'Tools & Ondersteuning',
    topics: {
      wincal: 'Wincal/configurator',
      opleiding_documentatie: 'Opleiding/documentatie/stalen',
    },
  },
  commercieel: {
    label: 'Commerciële dynamiek',
    topics: {
      leads_pipeline: 'Leads/pipeline-status',
      marketing_acties: 'Marketingacties',
      dealer_organisatie: 'Dealerorganisatie',
    },
  },
};

// Volgorde voor de per-categorie/globale weergave: R&D-relevante domeinen
// eerst, commerciële ruis laatst (zie renderTopicDomains/renderResults).
const DOMAIN_ORDER = Object.keys(TAXONOMY);

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
const analyzeStatus = document.getElementById('analyzeStatus');
const uploadBody = document.getElementById('uploadBody');
const uploadToggle = document.getElementById('uploadToggle');
const uploadSummary = document.getElementById('uploadSummary');
const filterBody = document.getElementById('filterBody');
const filterToggle = document.getElementById('filterToggle');
const filterSummary = document.getElementById('filterSummary');

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag');
  if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', (e) => {
  if (e.target.files.length) handleFiles(e.target.files);
});

// Leest één bestand in en geeft de genormaliseerde rijen terug (of gooit een
// fout) — los van handleFiles hieronder, zodat meerdere bestanden
// onafhankelijk van elkaar (en parallel) ingelezen kunnen worden.
function readFileRows(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
        resolve({ fileName: file.name, sheetName: wb.SheetNames[0], rows: normalizeRows(rows) });
      } catch (err) {
        reject(new Error(`${file.name}: ${err.message}`));
      }
    };
    reader.onerror = () => reject(new Error(`${file.name}: kon het bestand niet lezen`));
    reader.readAsArrayBuffer(file);
  });
}

// Verwerkt één of meerdere geselecteerde/gesleepte bestanden: elk apart
// inlezen, samenvoegen tot één rijenlijst, en dubbele rapporten eruit
// filteren (bv. wanneer twee maandexports elkaar in datum overlappen) — zie
// dedupeRows. Vervangt de oude handleFile(file), die enkel het eerste
// bestand verwerkte en de rest stilzwijgend negeerde.
async function handleFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  fname.textContent = files.length === 1 ? files[0].name : `${files.length} bestanden: ${files.map((f) => f.name).join(', ')}`;
  setStatus('Bestand(en) inlezen...');
  setAnalyzeStatus('');
  setCollapsed(uploadBody, uploadToggle, uploadSummary, false);
  // Nieuwe bestand(en): stap 1 (filter) moet opnieuw doorlopen worden voor
  // er geanalyseerd kan worden — dat voorkomt dat een oude filterselectie
  // (klant/rep uit een vorige upload) stilzwijgend blijft hangen.
  filterCard.hidden = true;
  filterBtn.disabled = true;
  analyzeBtn.disabled = true;

  const settled = await Promise.allSettled(files.map(readFileRows));
  const ok = [];
  const failed = [];
  settled.forEach((r) => {
    if (r.status === 'fulfilled') ok.push(r.value);
    else failed.push(r.reason.message);
  });

  if (!ok.length) {
    setStatus('Kon geen van de bestanden lezen: ' + failed.join('; ') + '.', true);
    filterBtn.disabled = true;
    return;
  }

  const combined = ok.flatMap((r) => r.rows);
  const { rows: deduped, removed } = dedupeRows(combined);
  parsedRows = deduped;

  const bronNote = ok.length === 1 ? `"${ok[0].sheetName}"` : `${ok.length} bestanden`;
  let msg = `${combined.length} rijen ingelezen uit ${bronNote}`;
  if (removed) msg += `, ${removed} dubbele rapporten (klant + datum + onderwerp) verwijderd → ${parsedRows.length} rijen over`;
  const period = reportPeriodLabel(parsedRows);
  if (period) msg += ` — periode: ${period}`;
  msg += failed.length ? `. Mislukt: ${failed.join('; ')}.` : '. Klik op "Filteren" om verder te gaan.';
  setStatus(msg, failed.length > 0);
  filterBtn.disabled = parsedRows.length === 0;
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
  setCollapsed(filterBody, filterToggle, filterSummary, false);
  updateFilterStatus();
  setStatus(`${parsedRows.length} rijen ingelezen. Kies eventueel een filter en klik op "Analyseren".`);
  // Bestand is gekozen en de filters staan klaar — de upload-kaart mag nu
  // plaats maken (Gwenn: "na het filteren, klap dit deel in").
  setCollapsed(uploadBody, uploadToggle, uploadSummary, true, uploadSummaryText());
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

// Dubbele rapporten verwijderen — nodig wanneer meerdere geëxporteerde
// bestanden elkaar in datum overlappen (bv. een YTD-export en een aparte
// maandexport). Twee rijen worden als "hetzelfde rapport" beschouwd als
// klant, datum ÉN onderwerp (de vrije tekst — Remark + Re) overeenkomen;
// enkel op klant+datum dedupliceren zou ook twee ECHT verschillende
// bezoeken op dezelfde dag bij dezelfde klant onterecht samenvoegen.
// Vergelijking is hoofdletter-/spatie-ongevoelig zodat kleine
// opmaakverschillen tussen twee exports (bv. dubbele spaties) geen
// "nieuwe" rij opleveren.
function dedupeKey(row) {
  const name = (row['name'] || '').trim().toLowerCase();
  const date = (row['date'] || '').trim().toLowerCase();
  const subject = [row['remark'], row['re']].filter(Boolean).join(' ').trim().toLowerCase().replace(/\s+/g, ' ');
  return `${name}|${date}|${subject}`;
}

function dedupeRows(rows) {
  const seen = new Set();
  const result = [];
  let removed = 0;
  for (const row of rows) {
    const key = dedupeKey(row);
    if (seen.has(key)) { removed++; continue; }
    seen.add(key);
    result.push(row);
  }
  return { rows: result, removed };
}

// De datumkolom (C) in de export bevat geen jaartal (bv. "Thu 10-09" =
// 10 september) — op vraag van Gwenn wordt daarvoor gewoon het huidige
// kalenderjaar genomen. Enkel voor de periode-melding bij het inlezen;
// de datumkolom zelf wordt nergens anders herrekend of gebruikt.
function parseReportDate(str) {
  if (!str) return null;
  const withYear = str.match(/(\d{2})-(\d{2})-(\d{4})/);
  if (withYear) {
    const [, dd, mm, yyyy] = withYear;
    const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
    return isNaN(d.getTime()) ? null : d;
  }
  const noYear = str.match(/(\d{2})-(\d{2})\s*$/);
  if (noYear) {
    const [, dd, mm] = noYear;
    const d = new Date(new Date().getFullYear(), Number(mm) - 1, Number(dd));
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// Oudste en meest recente datum over een set rijen — gebruikt bij het
// inlezen om te tonen welke periode de ingelezen rapporten dekken.
function reportPeriodLabel(rows) {
  const dates = rows.map((r) => parseReportDate(r['date'])).filter(Boolean);
  if (!dates.length) return null;
  const min = new Date(Math.min(...dates));
  const max = new Date(Math.max(...dates));
  const fmt = (d) => d.toLocaleDateString('nl-BE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  return min.getTime() === max.getTime() ? fmt(min) : `${fmt(min)} t/m ${fmt(max)}`;
}

function setStatus(msg, isErr) {
  statusText.textContent = msg;
  statusText.className = 'status' + (isErr ? ' err' : '');
}

// Status van de AI-analyse (stap 2) hoort naast de "Analyseren"-knop, niet
// naast "Filteren" — anders lijkt het alsof de voortgang bij de verkeerde
// knop hoort (zie screenshot van Gwenn).
function setAnalyzeStatus(msg, isErr) {
  analyzeStatus.textContent = msg;
  analyzeStatus.className = 'status' + (isErr ? ' err' : '');
}

// Generieke in-/uitklap-helper voor de upload-kaart en de filter+analyseer-
// kaart: verbergt de body, toont in de plaats een compacte samenvattingsregel
// (bv. bestandsnaam, of de gekozen filters) zodat de context niet helemaal
// verdwijnt. Wordt zowel automatisch aangeroepen (na Filteren/Analyseren,
// om plaats te besparen — zie Gwenn's screenshot) als handmatig via de
// pijltjesknop.
function setCollapsed(bodyEl, toggleEl, summaryEl, collapsed, summaryText) {
  bodyEl.hidden = collapsed;
  toggleEl.setAttribute('aria-expanded', String(!collapsed));
  toggleEl.innerHTML = collapsed ? '&#9656;' : '&#9662;';
  if (summaryEl) {
    summaryEl.hidden = !collapsed;
    summaryEl.closest('.card-head').classList.toggle('has-summary', collapsed);
    if (collapsed && summaryText != null) summaryEl.textContent = summaryText;
  }
}

function uploadSummaryText() {
  const base = fname.textContent || 'Geen bestand gekozen';
  return statusText.textContent ? `${base} — ${statusText.textContent}` : base;
}

function filterSummaryText() {
  const repLabel = filterRep.value || 'alle reps';
  const klantLabel = filterKlant.value || 'alle klanten';
  return `Filter: ${repLabel} · ${klantLabel}${filterStatus.textContent ? ' — ' + filterStatus.textContent : ''}`;
}

uploadToggle.addEventListener('click', () => {
  setCollapsed(uploadBody, uploadToggle, uploadSummary, !uploadBody.hidden, uploadSummaryText());
});
filterToggle.addEventListener('click', () => {
  setCollapsed(filterBody, filterToggle, filterSummary, !filterBody.hidden, filterSummaryText());
});

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

// Remarks-lijst (met klantnaam) om naar de AI te sturen — enkel klanten die
// ook effectief iets geschreven hebben dat (na filtering) over déze
// categorie gaat. Geen limiet meer hier: analyzeCategory hieronder verdeelt
// het resultaat zelf in batches van max. BATCH_SIZE opmerkingen.
function remarksForAi(customers, targetCat) {
  return customers
    .map((c) => ({ name: c.name, remark: filterRemarkForCategory(c.remark, targetCat) }))
    .filter((c) => c.remark);
}

// Verdeelt een array in stukken van max. `size` elementen. Een lege array
// geeft [[]] terug (één lege batch) zodat een categorie zonder opmerkingen
// nog steeds als één (leeg) verzoek naar de AI gaat, zoals voorheen.
function chunkArray(arr, size) {
  if (arr.length <= size) return [arr];
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

// Voegt tekstvelden van meerdere batches samen tot één geheel (getrimd,
// lege stukken overgeslagen, met een spatie gescheiden).
function joinText(parts) {
  return parts.map((p) => (p || '').trim()).filter(Boolean).join(' ');
}

// Eén AI-aanroep voor één batch (deel van) een categorie.
async function fetchAnalysisBatch(cat, existingRemarks, prospectingRemarks, potentialSum) {
  const res = await fetch(ANALYZE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      category: CATEGORY_LABELS[cat],
      existing: { remarks: existingRemarks },
      prospecting: { remarks: prospectingRemarks, potentialSum },
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
  return data.analysis;
}

// Voegt de analyses van meerdere batches van dezelfde categorie samen tot
// één object met dezelfde vorm als een los batch-resultaat, zodat
// buildGlobalOverview/renderResults ongewijzigd kunnen blijven. Lijstvelden
// (customer_sentiments, topic_tags, barriers) worden geconcateneerd —
// gelijkaardige topic_tags uit verschillende batches kunnen dus als
// aparte entries blijven staan i.p.v. samengevoegd tot één groep (geen
// semantische deduplicatie tussen batches); tekstvelden worden
// samengevoegd met joinText.
function mergeCategoryAnalyses(analyses) {
  const ec = analyses.map((a) => a.existing_customers || {});
  const pr = analyses.map((a) => a.prospecting || {});
  return {
    existing_customers: {
      general_impression: joinText(ec.map((e) => e.general_impression)),
      customer_sentiments: ec.flatMap((e) => e.customer_sentiments || []),
      topic_tags: ec.flatMap((e) => e.topic_tags || []),
      benchmark_product: joinText(ec.map((e) => e.benchmark_product)),
      benchmark_price: joinText(ec.map((e) => e.benchmark_price)),
    },
    prospecting: {
      potential_summary: joinText(pr.map((p) => p.potential_summary)),
      barriers: pr.flatMap((p) => p.barriers || []),
    },
  };
}

// Analyseert één categorie. Als er meer dan BATCH_SIZE bruikbare
// opmerkingen zijn (bestaand en/of prospecting, elk apart geteld), wordt
// dat deel in meerdere batches gesplitst die parallel naar de AI gaan; de
// resultaten worden nadien samengevoegd tot één analyse voor de hele
// categorie. Als één batch faalt maar minstens één andere lukt, gaat de
// analyse door op basis van wat wel gelukt is (met een console.warn).
async function analyzeCategory(cat, v) {
  const existingAll = remarksForAi(v.existing.customers, cat);
  const prospectingAll = remarksForAi(v.prospecting.customers, cat);
  const existingChunks = chunkArray(existingAll, BATCH_SIZE);
  const prospectingChunks = chunkArray(prospectingAll, BATCH_SIZE);
  const batchCount = Math.max(existingChunks.length, prospectingChunks.length);

  const settled = await Promise.allSettled(
    Array.from({ length: batchCount }, (_, i) =>
      fetchAnalysisBatch(cat, existingChunks[i] || [], prospectingChunks[i] || [], v.prospecting.potentialSum)
    )
  );

  const analyses = [];
  const errors = [];
  for (const r of settled) {
    if (r.status === 'fulfilled') analyses.push(r.value);
    else errors.push(r.reason.message);
  }
  if (!analyses.length) throw new Error(errors.join('; ') || 'onbekende fout');
  if (errors.length) {
    console.warn(`[${cat}] ${errors.length}/${batchCount} batch(es) mislukt: ${errors.join('; ')}`);
  }
  return mergeCategoryAnalyses(analyses);
}

document.getElementById('analyzeBtn').addEventListener('click', async () => {
  analyzeBtn.disabled = true;
  setAnalyzeStatus('Data structureren...');
  const filteredRows = getFilteredRows();
  const agg = buildAggregation(filteredRows);
  lastAgg = agg;
  const cats = Object.keys(CATEGORY_LABELS);
  showProgress(0, cats.length);

  // Eén analyse per categorie, parallel — dat geeft een écht
  // voortgangspunt (x van y klaar) in plaats van een nagebootste balk.
  // Elke categorie kan zelf uit meerdere AI-aanroepen bestaan als er veel
  // opmerkingen zijn (zie analyzeCategory/BATCH_SIZE hierboven) — dat blijft
  // hier verborgen, we wachten gewoon tot de hele categorie klaar is.
  let done = 0;
  const results = await Promise.all(cats.map(async (cat) => {
    const v = agg[cat];
    try {
      const analysis = await analyzeCategory(cat, v);
      return [cat, analysis, null];
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

  // Globaal overzicht (barometer) — volledig client-side uit de resultaten
  // hierboven, geen extra AI-aanroep nodig. Enkel de korte samenvattende
  // tekst erbij (loadGlobalSummary) is 1 kleine extra aanroep, en die laadt
  // apart/asynchroon zodat de rest van de resultaten niet hoeft te wachten.
  const globalOverview = buildGlobalOverview(agg, aiCategories);
  renderResults(agg, aiCategories, globalOverview);
  hideProgress();
  const filterNote = filteredRows.length === parsedRows.length
    ? `${parsedRows.length} rijen`
    : `${filteredRows.length} van ${parsedRows.length} rijen (filter: ${filterRep.value || 'alle reps'} / ${filterKlant.value || 'alle klanten'})`;
  if (failed.length) {
    setAnalyzeStatus(`Analyse deels mislukt voor: ${failed.join(', ')}. De andere categorieën zijn wel bijgewerkt.`, true);
  } else {
    setAnalyzeStatus(`Analyse voltooid op basis van ${filterNote}.`);
  }
  analyzeBtn.disabled = false;
  // Analyse is klaar en de resultaten staan hierboven — de filterkaart mag
  // nu plaats maken (Gwenn: "na het analyseren, klap ook dit deel in").
  setCollapsed(filterBody, filterToggle, filterSummary, true,
    `Filter: ${filterRep.value || 'alle reps'} · ${filterKlant.value || 'alle klanten'} — ${failed.length ? 'analyse deels mislukt' : 'analyse voltooid'} (${filterNote})`);
  if (Object.keys(aiCategories).length) loadGlobalSummary(globalOverview);
});

function showProgress(done, total) {
  const bar = document.getElementById('progressBar');
  const fill = document.getElementById('progressFill');
  bar.hidden = false;
  fill.style.width = Math.round((done / total) * 100) + '%';
  setAnalyzeStatus(`AI-analyse loopt: ${done}/${total} categorieën verwerkt...`);
}

function hideProgress() {
  document.getElementById('progressBar').hidden = true;
}

function activateTab(tabEl, sectionId) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  document.querySelectorAll('.section').forEach((s) => s.classList.remove('active'));
  tabEl.classList.add('active');
  document.getElementById(sectionId).classList.add('active');
}

function renderResults(agg, aiCategories, globalOverview) {
  const tabsEl = document.getElementById('tabs');
  const sectionsEl = document.getElementById('sections');
  tabsEl.innerHTML = '';
  sectionsEl.innerHTML = '';
  const cats = Object.keys(CATEGORY_LABELS);

  // "Globaal" eerst en actief bij openen — de barometer is het gevraagde
  // startpunt (score/werkpunten/sterke punten cross-categorie) vóór je in
  // een specifieke categorie duikt.
  const globalTab = document.createElement('div');
  globalTab.className = 'tab active';
  globalTab.textContent = 'Globaal';
  globalTab.onclick = () => activateTab(globalTab, 'section-global');
  tabsEl.appendChild(globalTab);

  const globalSection = document.createElement('div');
  globalSection.className = 'section active';
  globalSection.id = 'section-global';
  globalSection.innerHTML = renderGlobalSection(globalOverview);
  sectionsEl.appendChild(globalSection);

  cats.forEach((cat) => {
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.textContent = CATEGORY_LABELS[cat];
    tab.onclick = () => activateTab(tab, 'section-' + cat);
    tabsEl.appendChild(tab);

    const section = document.createElement('div');
    section.className = 'section';
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
        <h2 class="part-title" style="margin-top:18px;">Signalen voor R&amp;D &amp; Product Management</h2>
        ${renderTopicDomains(existingAi.topic_tags, cat, 'existing')}
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

/* --- Globale barometer (cross-categorie) ---------------------------------
 * Volledig opgebouwd uit de al opgehaalde per-categorie resultaten (agg +
 * aiCategories) — geen extra AI-aanroep nodig voor de cijfers zelf. Enkel
 * de lopende samenvattende tekst (loadGlobalSummary) is 1 kleine extra,
 * apart ladende aanroep naar de Worker (mode: 'global_summary').
 *
 * Score per categorie is bewust gebaseerd op AANTAL UNIEKE KLANTEN achter
 * positieve/negatieve thema's, niet op aantal thema's — anders weegt 1
 * spraakzame klant met meerdere thema's even zwaar als 4 verschillende
 * klanten (exact het schijnconsensus-probleem dat we bij Home/VIJVERMAN
 * zagen). "sampleSize" (hoeveel klanten er effectief een mening in zitten,
 * t.o.v. totalCustomers) laat toe om een score met weinig onderliggende
 * data zichtbaar te markeren i.p.v. hem even stellig te tonen.
 */
// Roadmap-relevante domeinen: hierop zijn de cross-categorie Sterke
// punten/Werkpunten-kaarten gebaseerd (zie renderGlobalSection). "Prijs &
// Concurrentiepositie" krijgt een eigen kaart (topCompetitors); "Tools &
// Ondersteuning" en "Commerciële dynamiek" blijven bewust weg uit dit
// cross-categorie overzicht (geen roadmap-signaal) — ze zijn wel te zien
// in de per-categorie taxonomie-weergave (renderTopicDomains).
const ROADMAP_DOMAINS = ['product_techniek', 'levering_logistiek', 'service_herstelling'];

function buildGlobalOverview(agg, aiCategories) {
  const cats = Object.keys(CATEGORY_LABELS);
  const perCategory = [];
  const allIssues = [];
  const allWishes = [];
  const allPositive = [];
  const allBarriers = [];
  const benchmarks = [];
  const competitorCustomers = new Map(); // concurrent-naam -> Set(klanten)
  let totalPotential = 0;
  let totalProspects = 0;

  for (const cat of cats) {
    const label = CATEGORY_LABELS[cat];
    const stats = agg[cat];
    const ai = (aiCategories && aiCategories[cat]) || {};
    const existingAi = ai.existing_customers || {};
    const prospAi = ai.prospecting || {};
    const tags = existingAi.topic_tags || [];
    const sentiments = existingAi.customer_sentiments || [];

    // Score-berekening: ongewijzigd gebaseerd op "customer_sentiments"
    // (verplichte, uitputtende per-opmerking classificatie uit worker.js)
    // — dat was precies de fix voor de instabiliteit tussen identieke runs
    // (zie consistentietest), en blijft los staan van de topic_tags-
    // taxonomie hieronder (die is voor de Sterke punten/Werkpunten-kaarten
    // en de per-categorie weergave, niet voor de score zelf).
    const posSet = new Set();
    const negSet = new Set();
    const anySet = new Set();
    const byCustomer = new Map();
    for (const s of sentiments) {
      if (!s || !s.customer) continue;
      if (!byCustomer.has(s.customer)) byCustomer.set(s.customer, []);
      byCustomer.get(s.customer).push(s.sentiment);
    }
    for (const [customer, list] of byCustomer) {
      // Bij meerdere opmerkingen van dezelfde klant telt het meest
      // kritische signaal: negatief > positief > neutraal > geen mening.
      let resolved = 'no_opinion';
      if (list.includes('negative')) resolved = 'negative';
      else if (list.includes('positive')) resolved = 'positive';
      else if (list.includes('neutral')) resolved = 'neutral';
      if (resolved === 'no_opinion') continue;
      anySet.add(customer);
      if (resolved === 'negative') negSet.add(customer);
      if (resolved === 'positive') posSet.add(customer);
    }

    const sampleSize = anySet.size;
    const totalCustomers = stats.existing.customers.length;
    const score = sampleSize ? (posSet.size - negSet.size) / sampleSize : null;

    perCategory.push({ cat, label, score, sampleSize, totalCustomers });

    // Groepeer topic_tags per domein+onderwerp (binnen deze categorie) om
    // per onderwerp het aantal unieke klanten met een positieve/negatieve
    // vermelding te tellen — dezelfde "unieke klanten, niet aantal tags"-
    // logica als bij de score hierboven, zodat 1 spraakzame klant ook hier
    // niet doorweegt.
    const byTopic = new Map();
    for (const t of tags) {
      if (!t || !t.domain || !t.topic) continue;
      const key = `${t.domain}|${t.topic}`;
      if (!byTopic.has(key)) {
        byTopic.set(key, { domain: t.domain, topic: t.topic, posCustomers: new Set(), negCustomers: new Set() });
      }
      const b = byTopic.get(key);
      if (t.customer && t.sentiment === 'positive') b.posCustomers.add(t.customer);
      if (t.customer && t.sentiment === 'negative') b.negCustomers.add(t.customer);

      if (t.domain === 'prijs_concurrentie' && t.topic === 'prijsvergelijking' && t.competitor) {
        const comp = t.competitor.trim();
        if (comp) {
          if (!competitorCustomers.has(comp)) competitorCustomers.set(comp, new Set());
          if (t.customer) competitorCustomers.get(comp).add(t.customer);
        }
      }
    }

    for (const { domain, topic, posCustomers, negCustomers } of byTopic.values()) {
      const topicLabel = (TAXONOMY[domain] && TAXONOMY[domain].topics[topic]) || topic;
      if (domain === 'product_techniek' && topic === 'feature_wens') {
        if (posCustomers.size || negCustomers.size) {
          allWishes.push({ cat, label, text: topicLabel, count: posCustomers.size + negCustomers.size });
        }
        continue;
      }
      if (!ROADMAP_DOMAINS.includes(domain)) continue;
      if (negCustomers.size) allIssues.push({ cat, label, text: topicLabel, count: negCustomers.size });
      if (posCustomers.size) allPositive.push({ cat, label, text: topicLabel, count: posCustomers.size });
    }

    for (const t of (prospAi.barriers || [])) {
      allBarriers.push({ cat, label, text: t.label, count: (t.customers || []).length });
    }

    totalPotential += stats.prospecting.potentialSum || 0;
    totalProspects += stats.prospecting.customers.length;

    if (existingAi.benchmark_product || existingAi.benchmark_price) {
      benchmarks.push({ cat, label, product: existingAi.benchmark_product || '—', price: existingAi.benchmark_price || '—' });
    }
  }

  const byCountDesc = (a, b) => b.count - a.count;
  allIssues.sort(byCountDesc);
  allWishes.sort(byCountDesc);
  allPositive.sort(byCountDesc);
  allBarriers.sort(byCountDesc);

  const topCompetitors = [...competitorCustomers.entries()]
    .map(([name, set]) => ({ name, count: set.size }))
    .sort(byCountDesc)
    .slice(0, 8);

  return {
    perCategory,
    topIssues: allIssues.slice(0, 8),
    topWishes: allWishes.slice(0, 8),
    topPositive: allPositive.slice(0, 8),
    topBarriers: allBarriers.slice(0, 8),
    topCompetitors,
    totalPotential,
    totalProspects,
    benchmarks,
  };
}

function renderGlobalSection(overview) {
  const scoreRows = overview.perCategory.map((c) => {
    if (c.score === null) {
      return `
        <div class="score-row">
          <span class="score-label">${escapeHtml(c.label)}</span>
          <div class="score-track"><div class="score-mid"></div></div>
          <span class="score-value">—</span>
          <span class="score-warn">0/${c.totalCustomers}</span>
        </div>`;
    }
    const pct = Math.round(Math.abs(c.score) * 50);
    const positive = c.score >= 0;
    const fillStyle = positive ? `left:50%;width:${pct}%;` : `left:${50 - pct}%;width:${pct}%;`;
    const lowSample = c.totalCustomers > 0 && c.sampleSize / c.totalCustomers < 0.3;
    return `
      <div class="score-row">
        <span class="score-label">${escapeHtml(c.label)}</span>
        <div class="score-track">
          <div class="score-mid"></div>
          <div class="score-fill ${positive ? 'pos' : 'neg'}" style="${fillStyle}"></div>
        </div>
        <span class="score-value ${positive ? 'pos' : 'neg'}">${positive ? '+' : ''}${Math.round(c.score * 100)}%</span>
        <span class="score-warn"${lowSample ? ' title="Gebaseerd op weinig klantopinies"' : ''}>${c.sampleSize}/${c.totalCustomers}</span>
      </div>`;
  }).join('');

  const rankedList = (items, badgeClass, badgeText, emptyText) => {
    if (!items.length) return `<p class="narrative">${emptyText}</p>`;
    return items.map((it) => `
      <div class="ranked-row">
        <span class="ranked-cat">${escapeHtml(it.label)}</span>
        <span class="ranked-text">${escapeHtml(it.text)}</span>
        <span class="pill ${badgeClass}">${badgeText}</span>
        <span class="count-badge">${it.count}</span>
      </div>`).join('');
  };

  const benchmarkRows = overview.benchmarks.map((b) => `
    <div class="benchmark-row">
      <div class="benchmark-cat">${escapeHtml(b.label)}</div>
      <div class="benchmark-col"><b>Product</b><p class="narrative">${escapeHtml(b.product)}</p></div>
      <div class="benchmark-col"><b>Prijs</b><p class="narrative">${escapeHtml(b.price)}</p></div>
    </div>`).join('');

  return `
    <div class="card">
      <h2 class="part-title">Globale barometer</h2>
      <p class="part-sub">Score per categorie op basis van unieke klanten met een uitgesproken opinie (niet op aantal thema's) — zo trekt 1 spraakzame klant de score niet scheef. Het getal rechts (bv. "3/23") toont op hoeveel klanten de score effectief steunt.</p>
      <p class="narrative" id="globalSummaryText">Samenvatting wordt gegenereerd...</p>
      <div class="score-list">${scoreRows}</div>
    </div>
    <div class="card">
      <h2 class="part-title">Sterke punten</h2>
      <p class="part-sub">Meest gedragen positieve signalen binnen Product &amp; Techniek / Levering &amp; Logistiek / Service &amp; Herstelling, over alle categorieën heen.</p>
      ${rankedList(overview.topPositive, 'positive', 'positief', 'Geen uitgesproken positieve signalen.')}
    </div>
    <div class="card">
      <h2 class="part-title">Werkpunten</h2>
      <p class="part-sub">Product-, leverings- en servicesignalen met minstens één negatieve melding, en gewenste features — over alle categorieën heen, gesorteerd op aantal klanten. Dit is het R&amp;D/Product Management-relevante deel van de taxonomie.</p>
      ${rankedList(overview.topIssues, 'issue', 'probleem', 'Geen technische/logistieke/service-meldingen gerapporteerd.')}
      ${rankedList(overview.topWishes, 'request', 'wens', 'Geen gewenste features gerapporteerd.')}
    </div>
    <div class="card">
      <h2 class="part-title">Concurrentiepositie</h2>
      <p class="part-sub">Meest vermelde concurrenten bij prijsvergelijkingen door bestaande klanten (taxonomie-domein "Prijs &amp; Concurrentiepositie"), over alle categorieën heen — apart van de productsignalen hierboven.</p>
      ${overview.topCompetitors && overview.topCompetitors.length
        ? overview.topCompetitors.map((c) => `
          <div class="ranked-row">
            <span class="ranked-text">${escapeHtml(c.name)}</span>
            <span class="count-badge">${c.count}</span>
          </div>`).join('')
        : '<p class="narrative">Geen concurrenten expliciet vermeld bij prijsvergelijkingen.</p>'}
    </div>
    <div class="card">
      <h2 class="part-title">Prospecting — totaal</h2>
      <div class="stat-row">
        <div class="stat"><b>${overview.totalProspects}</b><span>prospects (alle categorieën)</span></div>
        <div class="stat"><b>&euro;${Math.round(overview.totalPotential).toLocaleString('nl-BE')}</b><span>totaal potentieel (schatting)</span></div>
      </div>
      <h2 class="part-title" style="margin-top:16px;">Grootste drempels</h2>
      ${rankedList(overview.topBarriers, 'neutral', 'drempel', 'Geen drempels gerapporteerd.')}
    </div>
    <div class="card">
      <h2 class="part-title">Benchmark-snapshot</h2>
      ${benchmarkRows || '<p class="narrative">Geen benchmarkdata beschikbaar.</p>'}
    </div>
  `;
}

// Lichte, aparte AI-aanroep voor de lopende samenvattende tekst bovenaan de
// barometer — krijgt enkel de al samengevatte cijfers/labels (geen ruwe
// remarks), en laadt onafhankelijk van de rest zodat de 7 categorie-tabs
// er niet op moeten wachten.
async function loadGlobalSummary(overview) {
  const el = document.getElementById('globalSummaryText');
  if (!el) return;
  el.classList.add('loading');
  const categories = overview.perCategory
    .filter((c) => c.score !== null || c.totalCustomers > 0)
    .map((c) => ({
      label: c.label,
      scoreLabel: c.score === null ? 'onvoldoende data' : `${c.score >= 0 ? '+' : ''}${Math.round(c.score * 100)}%`,
      sampleSize: c.sampleSize,
      totalCustomers: c.totalCustomers,
      topPositive: overview.topPositive.filter((p) => p.cat === c.cat).map((p) => ({ label: p.text, count: p.count })),
      topIssues: overview.topIssues.filter((p) => p.cat === c.cat).map((p) => ({ label: p.text, count: p.count })),
      topWishes: overview.topWishes.filter((p) => p.cat === c.cat).map((p) => ({ label: p.text, count: p.count })),
    }));

  try {
    const res = await fetch(ANALYZE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'global_summary', categories }),
    });
    if (!res.ok) {
      let detail = '';
      try {
        const errBody = await res.json();
        detail = errBody.error || '';
      } catch {
        // geen JSON-body — geen detail beschikbaar
      }
      throw new Error(`status ${res.status}${detail ? ' — ' + detail : ''}`);
    }
    const data = await res.json();
    el.textContent = data.summary || 'Geen samenvatting beschikbaar.';
  } catch (err) {
    el.textContent = 'Samenvatting kon niet geladen worden (' + err.message + ').';
  } finally {
    el.classList.remove('loading');
  }
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

// Groepeert topic_tags (van één categorie/part) per domein+onderwerp —
// bron voor zowel de per-categorie taxonomie-weergave (renderTopicDomains)
// als de cross-categorie tellingen in buildGlobalOverview.
function groupTopicTags(tags) {
  const domains = {};
  for (const t of (tags || [])) {
    if (!t || !t.domain || !t.topic) continue;
    if (!domains[t.domain]) domains[t.domain] = {};
    if (!domains[t.domain][t.topic]) domains[t.domain][t.topic] = { customers: new Set(), entries: [] };
    const bucket = domains[t.domain][t.topic];
    if (t.customer) bucket.customers.add(t.customer);
    bucket.entries.push(t);
  }
  return domains;
}

// Overheersend sentiment binnen een topic-groep (voor de badge) — negatief
// weegt door zodra er minstens één negatieve tag is, net als bij de
// customer_sentiments-score (het meest kritische signaal telt).
function dominantSentiment(entries) {
  const counts = { negative: 0, positive: 0, neutral: 0 };
  for (const e of entries) {
    if (counts[e.sentiment] !== undefined) counts[e.sentiment]++;
  }
  if (counts.negative > 0) return 'negative';
  if (counts.positive > 0) return 'positive';
  return 'neutral';
}

// Eén uitklapbaar blokje per onderwerp: klantnamen (klikbaar, zie
// renderDetailsBlock) plus een paar concrete voorbeeld-citaten (het
// "detail"-veld per tag) — dat laatste is net wat een vaste taxonomie
// zonder kleur zou missen: telbaar ÉN nog steeds herkenbaar per geval.
function renderTopicBlock(topicLabel, bucket, cat, part) {
  const names = [...bucket.customers];
  const sentiment = dominantSentiment(bucket.entries);
  const details = [...new Set(bucket.entries.map((e) => e.detail).filter(Boolean))].slice(0, 3);
  const detailsHtml = details.length
    ? `<ul class="topic-detail-list">${details.map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul>`
    : '';
  const inner = `
    ${detailsHtml}
    ${names.length ? `<div class="customer-list">${names.map((n) => `<div>${customerLinkHtml(n, cat, part)}</div>`).join('')}</div>` : ''}
  `;
  return `
    <details class="theme-details">
      <summary>
        <span class="theme-label">${escapeHtml(topicLabel)}</span>
        <span class="theme-badges"><span class="pill ${sentiment}">${sentiment}</span> <span class="count-badge">${names.length}</span></span>
      </summary>
      ${inner}
    </details>
  `;
}

// Rendert een of meerdere domeinen uit de taxonomie (zie TAXONOMY/
// DOMAIN_ORDER hierboven) voor de gegeven topic_tags — elk aanwezig domein
// krijgt een eigen kopje, elk onderwerp daarbinnen een eigen uitklapblok,
// gesorteerd op aantal unieke klanten (grootste patroon eerst).
function renderTopicDomains(tags, cat, part, domainKeys) {
  const grouped = groupTopicTags(tags);
  const keys = domainKeys || DOMAIN_ORDER;
  const blocks = [];
  for (const domainKey of keys) {
    const topics = grouped[domainKey];
    if (!topics) continue;
    const domainLabel = TAXONOMY[domainKey].label;
    const topicKeys = Object.keys(topics).sort((a, b) => topics[b].customers.size - topics[a].customers.size);
    const topicBlocks = topicKeys
      .map((topicKey) => renderTopicBlock(TAXONOMY[domainKey].topics[topicKey] || topicKey, topics[topicKey], cat, part))
      .join('');
    blocks.push(`<h2 class="part-title" style="margin-top:18px;">${escapeHtml(domainLabel)}</h2>${topicBlocks}`);
  }
  return blocks.join('') || '<p class="narrative">Geen classificeerbare signalen.</p>';
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
