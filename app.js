/* Winsol Feedbackloop — client-side logic
 * 1) Parse uploaded CRM-export (xlsx/xls/csv, incl. legacy SpreadsheetML .xls)
 * 2) "Opladen" (admin, sporadisch, kost AI-aanroepen):
 *    a) Classify each row into Screens / Shutters / Fusion / Luifels /
 *       Pergola / Outdoor / Home + bestaande klant vs. prospect
 *    b) Reken de harde cijfers lokaal uit (aantallen, potentieel in €, wie
 *       de klanten zijn) — dat gaat dus nooit "gokken"
 *    c) Stuur enkel de samengevatte cijfers + klantnamen + opmerkingen naar
 *       de Worker (worker.js), die Claude vraagt om de kwalitatieve synthese
 *       — de Worker cachet die classificatie meteen per opmerking in KV
 *    d) Toont het volledige resultaat meteen (incl. verhalende tekst) —
 *       eenmalig, enkel hier; dit wordt nergens bewaard voor later.
 * 3) "Filteren" (admin én user-rol, standaardgebruik, GEEN nieuwe AI-
 *    aanroep): regio/rep/klant kiezen en de KV-cache bevragen
 *    (renderCachedFilter) — ALTIJD, ook meteen na een "Opladen" en ook
 *    zonder filter ("Alle" overal): dit is bewust geen shortcut naar het
 *    zonet getoonde resultaat, om één consistent gedrag te houden.
 *    Verhalende AI-tekst ontbreekt hier daarom altijd (nooit per opmerking
 *    gecached) — enkel de cijfers/thema's/klantenlijsten komen uit de
 *    cache. Een rij moet aan alle gekozen filters voldoen (EN).
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

// Zelfde als matchesKeyword, maar zonder woordgrens aan de RECHTERkant —
// nodig voor Nederlandse samenstellingen waarbij het trefwoord het eerste
// deel van een langer woord is (bv. "screendoek", "screendoekvervanging"
// bevatten "screen" niet als los woord, wel als voorvoegsel). Enkel gebruikt
// voor trefwoorden in PREFIX_KEYWORDS hieronder — bewust niet toegepast op
// alle trefwoorden, want voor korte/generieke woorden (bv. "tent", dat ook
// in "potentieel" zit) zou dat net valse treffers opleveren. De linkerkant
// blijft wel een echte woordgrens, dus "afscreenen" e.d. matcht nog steeds
// niet als los ander woord toevallig op "screen" eindigt.
function matchesKeywordPrefix(text, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}`, 'i').test(text);
}

// "SO" (zonder "!") is dubbelzinniger dan "SO!" — in hoofdletters (SO) is
// het vrijwel altijd het merk en telt het direct mee voor Pergola; in
// kleine letters ("so") is het een courant los woord, dus die telt enkel
// mee als "pergola" ook ergens in dezelfde tekst voorkomt (ter bevestiging).
function matchesBareSO(text) {
  if (/(^|[^a-zA-Z0-9])SO($|[^a-zA-Z0-9])/.test(text)) return true;
  return matchesKeyword(text, 'so') && matchesKeyword(text, 'pergola');
}

// Trefwoorden die ook als voorvoegsel van een samengesteld woord mogen
// matchen (matchesKeywordPrefix hierboven) — gevonden bij een analyse
// (i.o.v. Gwenn) op 3 maanden BE-data: "screendoekvervanging" e.d. bleven
// ongecategoriseerd omdat "screen" met de gewone woordgrens niet matcht op
// een samenstelling. Bewust beperkt tot trefwoorden waar dit veilig is
// (geen courant ander woord dat toevallig met dezelfde letters begint) —
// dus niet zomaar uitgebreid naar alle KEYWORDS-trefwoorden hierboven.
const PREFIX_KEYWORDS = {
  screens: ['screen'],
};

// Welke categorieën komen voor in een los stukje tekst (op basis van de
// trefwoorden) — gedeeld door classifyCategories (hele rij) en
// filterRemarkForCategory (per zin, voor de AI-input).
function categoriesInText(text) {
  const cats = new Set();
  for (const cat of Object.keys(KEYWORDS)) {
    if (KEYWORDS[cat].some((w) => matchesKeyword(text, w))) cats.add(cat);
  }
  for (const cat of Object.keys(PREFIX_KEYWORDS)) {
    if (PREFIX_KEYWORDS[cat].some((w) => matchesKeywordPrefix(text, w))) cats.add(cat);
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
// --- Doorlooptijd: de rekensom achter deze twee getallen ---
// De totale wachttijd van "Opladen" wordt bijna volledig bepaald door hoeveel
// tokens de AI moet GENEREREN, niet door het netwerk of de KV. Per opmerking
// produceert het model ~1 sentiment-entry + gemiddeld ~2 à 3 topic_tags (elk
// met een "detail"-zin), samen ruwweg 150 tokens. Een maand BE-data geeft zo'n
// 250 klant/categorie-combinaties => ~38.000 tokens die hoe dan ook gegenereerd
// moeten worden. Eén stream haalt ~60 tokens/seconde, dus:
//
//     totale wachttijd ~= (aantal opmerkingen x 150) / concurrency / 60
//
// Dat verklaart alle metingen van 13/09: bij concurrency 3 gaf dat ~5 minuten
// (en dat was ook exact wat we zagen), bij 6 ~2,5 minuten. De enige echte
// hendel voor SNELHEID is dus concurrency — niet BATCH_SIZE.
//
// BATCH_SIZE bepaalt iets anders: hoeveel tokens één enkele aanroep moet
// genereren, en dus of die binnen de 90s-timeout blijft. Bij 60 opmerkingen
// (~9.000 tokens, >2 minuten) ging dat structureel mis; bij 12 zit één aanroep
// rond de 1.800 tokens (~30s) en is er ruime marge.
//
// Samen: veel kleine aanroepen, flink parallel. Dat is sneller én betrouwbaarder
// dan de grote-batch-aanpak, want de trage stap (genereren) wordt dan echt
// verdeeld i.p.v. geserialiseerd.
const BATCH_SIZE = 12;
// Meting 13/09 (211 rijen): 22 aanroepen, 1m26s bij concurrency 15 — dus twee
// "golven" van 15 en 7. Met 25 past een normale maand in één golf, wat de
// tweede golf (~35s) uitspaart. Ruimte genoeg: van de 2.000.000
// output-tokens/min van het account gebruikt een volledige run er ~34.000.
const ANALYSIS_CONCURRENCY = 25;
// Begrenst hoeveel AI-aanroepen er tegelijk lopen. De prompt cache wordt
// apart opgewarmd vóór de run start (zie warmPromptCache) — dat mag hier dus
// geen rol meer spelen.
function createLimiter(concurrency) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (queue.length && active < concurrency) {
      active++;
      const { fn, resolve, reject } = queue.shift();
      fn().then(resolve, reject).finally(() => {
        active--;
        pump();
      });
    }
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}
const limitAnalysisCall = createLimiter(ANALYSIS_CONCURRENCY);

// Schrijft de vaste system-prompt één keer naar Anthropic's cache vóór de
// eigenlijke aanroepen vertrekken, zodat die er allemaal uit lezen i.p.v. elk
// hun eigen kopie te schrijven. Kost een paar seconden. Mislukt dit, dan gaat
// de analyse gewoon door (enkel iets duurder) — nooit blokkeren hierop.
async function warmPromptCache() {
  try {
    await authRequest({ mode: 'warm_cache' });
  } catch (err) {
    console.warn('Opwarmen van de prompt cache mislukt:', err.message);
  }
}
// Telt, over alle categorie/batch-aanroepen van één "Opladen"-run heen, hoe
// veel per-opmerking cache-writes de Worker heeft geprobeerd/gehaald — zie
// fetchAnalysisBatch. Wordt bij elke "Opladen"-klik gereset en nadien in de
// statusmelding getoond, zodat een stille cache-schrijffout (bv. door een
// Cloudflare-quotum) meteen zichtbaar is in de UI i.p.v. enkel in
// Worker-logs ("wrangler tail").
let cacheWriteStats = { attempted: 0, succeeded: 0, failed: 0, firstError: '' };
// Diagnose (i.o.v. Gwenn): Screens/Home tonen herhaaldelijk 0 bruikbare
// signalen, ook meteen na "Opladen". Verzamelt per categorie of de AI een
// onvolledig/afgekapt antwoord gaf (zie worker.js: diagnostics.stopReason/
// missingIds) — zodat we dat in de statusmelding kunnen tonen i.p.v. te
// moeten gokken. Key = interne categoriesleutel (bv. "screens").
let aiResponseIssues = {};
// Verbruik + accountlimieten van Claude's API over één "Opladen"-run heen.
// De rate-limit-headers zijn de enige manier om te zien of trage aanroepen aan
// de inhoud liggen of gewoon aan de limiet van het Anthropic-account: als
// "outputRemaining" op 0 staat, zit je tegen het plafond en helpt geen enkele
// batch-/concurrency-instelling nog.
let aiUsageStats = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0, limits: null, minOutputRemaining: null, startedAt: 0 };

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
      onderdeel_defect: 'Onderdeelkwaliteit',
      bediening_domotica: 'Bediening/motorisatie/domotica',
      kleur_afwerking: 'Kleur/afwerking',
      maatvoering_beperking: 'Maatvoering/technische mogelijkheden',
      feature_wens: 'Functionaliteit/productwens',
    },
  },
  levering_logistiek: {
    label: 'Levering & Logistiek',
    topics: {
      levertermijn: 'Levertermijn',
      foutieve_levering: 'Juistheid van levering',
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
const filterRegio = document.getElementById('filterRegio');
const filterRep = document.getElementById('filterRep');
const filterKlant = document.getElementById('filterKlant');
const filterVan = document.getElementById('filterVan');
const filterTot = document.getElementById('filterTot');
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

// ============================================================
// Auth (Fase 1: login & rollen)
// ============================================================
// Token wordt bewaard in localStorage ("blijf aangemeld") of sessionStorage
// (enkel dit tabblad/deze sessie) — zelfde patroon als Winsol-Socrates.
// Alle aanroepen naar de Worker (analyse, globale samenvatting, auth zelf)
// sturen de token mee via de X-Auth-Token header (zie authHeaders()).
const TOKEN_KEY = 'feedbackloop_token';
let authToken = '';
let authRole = '';
let authUsername = '';

function authHeaders() {
  return authToken ? { 'X-Auth-Token': authToken } : {};
}

const loginScreen = document.getElementById('loginScreen');
const appRoot = document.getElementById('appRoot');
const loginUsername = document.getElementById('loginUsername');
const loginPassword = document.getElementById('loginPassword');
const loginPwToggle = document.getElementById('loginPwToggle');
const loginRemember = document.getElementById('loginRemember');
const loginSubmitBtn = document.getElementById('loginSubmitBtn');
const loginError = document.getElementById('loginError');
const topbar = document.getElementById('topbar');
const topbarUser = document.getElementById('topbarUser');
const topbarRole = document.getElementById('topbarRole');
const logoutBtn = document.getElementById('logoutBtn');
const uploadCard = document.getElementById('uploadCard');
const userPlaceholderCard = document.getElementById('userPlaceholderCard');
const userViewCard = document.getElementById('userViewCard');
const userFilterRegio = document.getElementById('userFilterRegio');
const userFilterRep = document.getElementById('userFilterRep');
const userFilterKlant = document.getElementById('userFilterKlant');
const userFilterKlantList = document.getElementById('userFilterKlantList');
const userViewBtn = document.getElementById('userViewBtn');
const userViewStatus = document.getElementById('userViewStatus');
const usersCard = document.getElementById('usersCard');
const usersDropzone = document.getElementById('usersDropzone');
const usersFileInput = document.getElementById('usersFileInput');
const usersFname = document.getElementById('usersFname');
const usersUpdateBtn = document.getElementById('usersUpdateBtn');
const usersStatus = document.getElementById('usersStatus');
const cacheCard = document.getElementById('cacheCard');
const cacheResetBtn = document.getElementById('cacheResetBtn');
const cacheResetExistingBtn = document.getElementById('cacheResetExistingBtn');
const heroSub = document.getElementById('heroSub');
const cacheResetExistingStatus = document.getElementById('cacheResetExistingStatus');
const cacheResetProspectsBtn = document.getElementById('cacheResetProspectsBtn');
const cacheResetProspectsStatus = document.getElementById('cacheResetProspectsStatus');
const cacheStatus = document.getElementById('cacheStatus');
const cacheStats = document.getElementById('cacheStats');
const usersBody = document.getElementById('usersBody');
const usersToggle = document.getElementById('usersToggle');
const usersSummary = document.getElementById('usersSummary');

async function authRequest(bodyObj) {
  const res = await fetch(ANALYZE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(bodyObj),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    // geen (geldige) JSON-body
  }
  return { ok: res.ok, status: res.status, data };
}

function showApp(username, role) {
  authUsername = username;
  authRole = role;
  loginScreen.style.display = 'none';
  appRoot.style.display = 'block';
  topbar.hidden = false;
  topbarUser.textContent = username;
  topbarRole.textContent = role === 'admin' ? 'admin' : 'user';
  const isAdmin = role === 'admin';
  // De ondertitel spreekt de rol aan die ze leest: een user laadt niets op, dus
  // "upload de CRM-export" is voor hem enkel ruis. Hij krijgt in twee regels
  // waar de tool voor dient en wat hij ermee kan.
  if (heroSub) {
    heroSub.innerHTML = isAdmin
      ? 'Upload de CRM-export en laat AI de klantenfeedback analyseren per productcategorie.'
      : 'Wat vertellen onze klanten en prospects tijdens de bezoeken? Deze tool leest alle bezoekverslagen en bundelt ze per productcategorie.<br>'
        + 'Filter op regio, vertegenwoordiger, klant of periode en zie meteen wat goed loopt, waar het knelt en welke concurrenten genoemd worden.';
  }
  // Admin: upload/analyseren/beheer. User: enkel filters op de gecachete
  // data (Fase 5) — welke van de twee kaarten (placeholder of echte
  // filters) verschijnt, hangt af van of de cache al iets bevat; dat wordt
  // hieronder async bepaald via loadUserView().
  uploadCard.hidden = !isAdmin;
  filterCard.hidden = true;
  usersCard.hidden = !isAdmin;
  cacheCard.hidden = !isAdmin;
  userPlaceholderCard.hidden = true;
  userViewCard.hidden = true;
  if (!isAdmin) {
    loadUserView();
  } else {
    loadCacheStats();
  }
}

function showLogin(message) {
  authToken = '';
  authRole = '';
  authUsername = '';
  try {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // localStorage/sessionStorage kan geblokkeerd zijn (privénavigatie) — geen probleem
  }
  appRoot.style.display = 'none';
  loginScreen.style.display = 'flex';
  topbar.hidden = true;
  loginPassword.value = '';
  loginError.textContent = message || '';
}

async function doLogin() {
  const username = loginUsername.value.trim();
  const password = loginPassword.value;
  const remember = loginRemember.checked;
  loginError.textContent = '';
  if (!username || !password) {
    loginError.textContent = 'Vul gebruikersnaam en wachtwoord in.';
    return;
  }
  loginSubmitBtn.disabled = true;
  loginSubmitBtn.textContent = 'Aanmelden…';
  try {
    const { ok, data } = await authRequest({ mode: 'login', username, password, remember });
    if (!ok) {
      loginError.textContent = data.error || 'Aanmelden mislukt.';
      return;
    }
    authToken = data.token;
    const storage = remember ? localStorage : sessionStorage;
    try {
      storage.setItem(TOKEN_KEY, authToken);
    } catch {
      // storage geblokkeerd — token blijft dan enkel in het geheugen (werkt nog tot page refresh)
    }
    showApp(data.username, data.role);
  } catch {
    loginError.textContent = 'Kon niet verbinden met de server.';
  } finally {
    loginSubmitBtn.disabled = false;
    loginSubmitBtn.textContent = 'Aanmelden';
  }
}

loginSubmitBtn.addEventListener('click', doLogin);
loginPassword.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLogin();
});
loginUsername.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loginPassword.focus();
});
loginPwToggle.addEventListener('click', () => {
  loginPassword.type = loginPassword.type === 'password' ? 'text' : 'password';
});
logoutBtn.addEventListener('click', async () => {
  try {
    await authRequest({ mode: 'logout' });
  } catch {
    // best-effort — lokaal loggen we sowieso uit
  }
  showLogin();
});

async function tryRestoreSession() {
  const token = localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || '';
  if (!token) {
    showLogin();
    return;
  }
  authToken = token;
  try {
    const { ok, data } = await authRequest({ mode: 'auth_me' });
    if (ok) {
      showApp(data.username, data.role);
    } else {
      showLogin();
    }
  } catch {
    showLogin('Kon niet verbinden met de server — probeer opnieuw in te loggen.');
  }
}

tryRestoreSession();

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

// Fase 3: regio (BE/FR/EX) wordt afgeleid uit de bestandsnaam, bv.
// "history_BE_09-2026.xls" (regio + maand-jaar). Bij één foute
// bestandsnaam wordt de HELE batch geweigerd (geen gedeeltelijke
// verwerking) — expliciete afspraak met Gwenn, zodat er nooit rijen zonder
// (of met een verkeerde) regio in de resultaten kunnen sluipen.
const FILENAME_REGION_RE = /^history_(BE|FR|EX)_\d{2}-\d{4}\.(xlsx?|csv)$/i;

// Verwerkt één of meerdere geselecteerde/gesleepte bestanden: elk apart
// inlezen, samenvoegen tot één rijenlijst, en dubbele rapporten eruit
// filteren (bv. wanneer twee maandexports elkaar in datum overlappen) — zie
// dedupeRows. Vervangt de oude handleFile(file), die enkel het eerste
// bestand verwerkte en de rest stilzwijgend negeerde.
async function handleFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  fname.textContent = files.length === 1 ? files[0].name : `${files.length} bestanden: ${files.map((f) => f.name).join(', ')}`;

  // Bestandsnamen eerst valideren, vóór er iets ingelezen wordt: bij één
  // foute naam wordt niets verwerkt.
  const regionByFile = new Map();
  const badNames = [];
  for (const f of files) {
    const m = f.name.match(FILENAME_REGION_RE);
    if (m) regionByFile.set(f.name, m[1].toUpperCase());
    else badNames.push(f.name);
  }
  if (badNames.length) {
    setStatus(
      `Bestandsnaam voldoet niet aan het verwachte formaat "history_BE|FR|EX_MM-JJJJ.xls(x)": ${badNames.join(', ')}. Er is niets verwerkt.`,
      true
    );
    setAnalyzeStatus('');
    filterCard.hidden = true;
    filterBtn.disabled = true;
    analyzeBtn.disabled = true;
    return;
  }

  setStatus('Bestand(en) inlezen...');
  setAnalyzeStatus('');
  setCollapsed(uploadBody, uploadToggle, uploadSummary, false);
  // Nieuwe bestand(en): stap 1 (filter) moet opnieuw doorlopen worden voor
  // er geanalyseerd kan worden — dat voorkomt dat een oude filterselectie
  // (klant/rep/regio uit een vorige upload) stilzwijgend blijft hangen.
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

  const combined = ok.flatMap((r) => r.rows.map((row) => ({ ...row, regio: regionByFile.get(r.fileName), sourceFile: r.fileName })));
  const { rows: deduped, removed } = dedupeRows(combined);
  parsedRows = deduped;

  const bronNote = ok.length === 1 ? `"${ok[0].sheetName}"` : `${ok.length} bestanden`;
  let msg = `${combined.length} rijen ingelezen uit ${bronNote}`;
  if (removed) msg += `, ${removed} dubbele rapporten (klant + datum + onderwerp) verwijderd → ${parsedRows.length} rijen over`;
  const period = reportPeriodLabel(parsedRows);
  if (period) msg += ` — periode: ${period}`;
  msg += failed.length ? `. Mislukt: ${failed.join('; ')}.` : '. Klik op "Opladen" om te analyseren.';
  setStatus(msg, failed.length > 0);
  filterBtn.disabled = parsedRows.length === 0;
}

// ============================================================
// Fase 2: Users beheren (admin) — upload van een Users-Excel (kolommen
// USER/PW/ROLE, zelfde structuur als het bestand waarmee de admin/Test-
// accounts oorspronkelijk via wrangler werden aangemaakt) om accounts
// voortaan zelf te kunnen toevoegen/bijwerken zonder wrangler-commando's.
// Hergebruikt readFileRows: normalizeRows maakt kolomnamen al lowercase +
// getrimd, dus de kolommen komen hier binnen als 'user', 'pw', 'role'.
// Bestaande gebruikers die niet in het bestand voorkomen blijven
// ongewijzigd (upsert, geen volledige vervanging) — de Worker (mode
// admin_upsert_users) doet enkel toevoegen/overschrijven per username.
// ============================================================
let parsedUserRows = [];

function setUsersStatus(msg, isErr) {
  usersStatus.textContent = msg;
  usersStatus.className = 'status' + (isErr ? ' err' : '');
}

usersDropzone.addEventListener('click', () => usersFileInput.click());
usersDropzone.addEventListener('dragover', (e) => { e.preventDefault(); usersDropzone.classList.add('drag'); });
usersDropzone.addEventListener('dragleave', () => usersDropzone.classList.remove('drag'));
usersDropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  usersDropzone.classList.remove('drag');
  if (e.dataTransfer.files.length) handleUsersFile(e.dataTransfer.files[0]);
});
usersFileInput.addEventListener('change', (e) => {
  if (e.target.files.length) handleUsersFile(e.target.files[0]);
});

async function handleUsersFile(file) {
  usersFname.textContent = file.name;
  setUsersStatus('Bestand inlezen...');
  usersUpdateBtn.disabled = true;
  parsedUserRows = [];
  setCollapsed(usersBody, usersToggle, usersSummary, false);
  let parsed;
  try {
    parsed = await readFileRows(file);
  } catch (err) {
    setUsersStatus(err.message, true);
    return;
  }
  const rows = parsed.rows
    .map((r) => ({
      username: (r['user'] || '').trim(),
      password: (r['pw'] || '').trim(),
      role: (r['role'] || '').trim().toLowerCase(),
    }))
    .filter((r) => r.username || r.password);
  if (!rows.length) {
    setUsersStatus('Geen bruikbare rijen gevonden — verwacht kolommen USER, PW en ROLE.', true);
    return;
  }
  parsedUserRows = rows;
  setUsersStatus(`${rows.length} rijen ingelezen uit "${parsed.sheetName}". Klik op "Users bijwerken" om te bevestigen.`);
  usersUpdateBtn.disabled = false;
}

usersUpdateBtn.addEventListener('click', async () => {
  if (!parsedUserRows.length) return;
  usersUpdateBtn.disabled = true;
  setUsersStatus('Bezig met bijwerken...');
  try {
    const { ok, status, data } = await authRequest({ mode: 'admin_upsert_users', users: parsedUserRows });
    if (status === 401 || status === 403) {
      showLogin(status === 401 ? 'Sessie verlopen — log opnieuw in.' : 'Geen toegang.');
      return;
    }
    if (!ok) {
      setUsersStatus((data && data.error) || 'Bijwerken mislukt.', true);
      usersUpdateBtn.disabled = false;
      return;
    }
    let msg = `${data.updated} van ${data.total} gebruikers bijgewerkt.`;
    if (data.errors && data.errors.length) msg += ` Fouten: ${data.errors.join('; ')}`;
    setUsersStatus(msg, !!(data.errors && data.errors.length));
    usersUpdateBtn.disabled = false;
    // Bij succes (geen fouten) inklappen, net als de upload-kaart na een
    // geslaagde filter — bespaart plaats, samenvatting blijft zichtbaar.
    if (!(data.errors && data.errors.length)) {
      setCollapsed(usersBody, usersToggle, usersSummary, true, usersSummaryText());
    }
  } catch (err) {
    setUsersStatus('Bijwerken mislukt: ' + err.message, true);
    usersUpdateBtn.disabled = false;
  }
});

// ============================================================
// Fase 4: Cache beheren (admin) — volledige cache (per-opmerking
// AI-classificatie in Workers KV) wissen. Wist enkel "remark:*"-entries;
// gebruikersaccounts/sessies (user:*/session:*) blijven behouden — de
// Worker (mode cache_reset) zorgt daarvoor.
// ============================================================
const CACHE_STATS_REGIO_ORDER = ['BE', 'FR', 'EX'];

async function loadCacheStats() {
  cacheStats.textContent = 'Cache-inhoud wordt geladen...';
  try {
    const { ok, status, data } = await authRequest({ mode: 'cached_options' });
    if (status === 401 || status === 403) {
      showLogin(status === 401 ? 'Sessie verlopen — log opnieuw in.' : 'Geen toegang.');
      return;
    }
    if (!ok) {
      cacheStats.textContent = 'Kon cache-inhoud niet ophalen: ' + ((data && data.error) || 'onbekende fout') + '.';
      return;
    }
    const counts = data.regioCounts || {};
    const knownRegios = CACHE_STATS_REGIO_ORDER.filter((r) => r in counts);
    const otherRegios = Object.keys(counts).filter((r) => !CACHE_STATS_REGIO_ORDER.includes(r));
    const parts = [...knownRegios, ...otherRegios.sort()].map((r) => `${r}: ${counts[r]}`);
    if (!parts.length) {
      cacheStats.textContent = 'Cache is momenteel leeg (0 gecachete opmerkingen).';
      return;
    }
    cacheStats.textContent = `Gecachet per regio — ${parts.join(' · ')} (totaal: ${data.total} opmerking-categorie-combinaties).`;
  } catch (err) {
    cacheStats.textContent = 'Kon cache-inhoud niet ophalen: ' + err.message;
  }
}

// Eenmalige actie na een uitbreiding van wat de AI per klantopmerking moet
// vastleggen (14/09: de concurrentnaam bij élk onderwerp, niet enkel bij een
// prijsvergelijking). Wist enkel de klant-classificaties; prospects blijven
// staan, want die dragen geen thema-tags en dus ook geen concurrentnaam.
// Daarna worden de klantopmerkingen bij de eerstvolgende upload per maand
// opnieuw geanalyseerd — de prospects blijven gratis uit de cache komen.
cacheResetExistingBtn.addEventListener('click', async () => {
  if (!confirm('Alle classificaties van BESTAANDE KLANTEN wissen? Prospects blijven behouden. Je moet daarna elk maandbestand één keer opnieuw opladen; enkel de klantopmerkingen worden dan opnieuw geanalyseerd (raming: ongeveer 2 euro in totaal). Doorgaan?')) {
    return;
  }
  cacheResetExistingBtn.disabled = true;
  cacheResetExistingStatus.textContent = 'Bezig met wissen...';
  cacheResetExistingStatus.className = 'status';
  try {
    const { ok, status, data } = await authRequest({ mode: 'cache_reset_existing' });
    if (status === 401 || status === 403) {
      showLogin(status === 401 ? 'Sessie verlopen — log opnieuw in.' : 'Geen toegang.');
      return;
    }
    if (!ok) {
      cacheResetExistingStatus.textContent = (data && data.error) || 'Wissen mislukt.';
      cacheResetExistingStatus.className = 'status err';
    } else {
      cacheResetExistingStatus.textContent =
        `${data.verwijderd} klant-classificatie(s) gewist, ${data.behouden} prospect-record(s) behouden. ` +
        'Laad nu elk maandbestand één keer opnieuw op.';
      cacheResetExistingStatus.className = 'status';
    }
  } catch (err) {
    cacheResetExistingStatus.textContent = 'Wissen mislukt: ' + err.message;
    cacheResetExistingStatus.className = 'status err';
  } finally {
    cacheResetExistingBtn.disabled = false;
  }
});

// Spiegelbeeld van de knop hierboven: enkel de prospectrecords wissen. Nodig
// sinds prospect_signals ook een concurrentnaam vastlegt — zonder hercachering
// blijft dat veld leeg voor alles wat al in de KV zit.
cacheResetProspectsBtn.addEventListener('click', async () => {
  if (!confirm('Alle classificaties van PROSPECTS wissen? Klantclassificaties blijven behouden. Je moet daarna elk maandbestand één keer opnieuw opladen; enkel de prospectopmerkingen worden dan opnieuw geanalyseerd (raming: ongeveer 3 tot 4 euro in totaal). Doorgaan?')) {
    return;
  }
  cacheResetProspectsBtn.disabled = true;
  cacheResetProspectsStatus.textContent = 'Bezig met wissen...';
  cacheResetProspectsStatus.className = 'status';
  try {
    const { ok, status, data } = await authRequest({ mode: 'cache_reset_prospects' });
    if (status === 401 || status === 403) {
      showLogin(status === 401 ? 'Sessie verlopen — log opnieuw in.' : 'Geen toegang.');
      return;
    }
    if (!ok) {
      cacheResetProspectsStatus.textContent = (data && data.error) || 'Wissen mislukt.';
      cacheResetProspectsStatus.className = 'status err';
    } else {
      cacheResetProspectsStatus.textContent =
        `${data.verwijderd} prospect-record(s) gewist, ${data.behouden} klant-classificatie(s) behouden. ` +
        'Laad nu elk maandbestand één keer opnieuw op.';
      cacheResetProspectsStatus.className = 'status';
    }
  } catch (err) {
    cacheResetProspectsStatus.textContent = 'Wissen mislukt: ' + err.message;
    cacheResetProspectsStatus.className = 'status err';
  } finally {
    cacheResetProspectsBtn.disabled = false;
  }
});

cacheResetBtn.addEventListener('click', async () => {
  if (!confirm('Volledige cache wissen? Bij de volgende analyse wordt alles opnieuw door de AI verwerkt. Gebruikersaccounts blijven behouden. Doorgaan?')) {
    return;
  }
  cacheResetBtn.disabled = true;
  cacheStatus.textContent = 'Bezig met wissen...';
  cacheStatus.className = 'status';
  try {
    const { ok, status, data } = await authRequest({ mode: 'cache_reset' });
    if (status === 401 || status === 403) {
      showLogin(status === 401 ? 'Sessie verlopen — log opnieuw in.' : 'Geen toegang.');
      return;
    }
    if (!ok) {
      cacheStatus.textContent = (data && data.error) || 'Wissen mislukt.';
      cacheStatus.className = 'status err';
      cacheResetBtn.disabled = false;
      return;
    }
    cacheStatus.textContent = `Cache gewist (${data.deleted} entries).`;
    cacheStatus.className = 'status';
    cacheResetBtn.disabled = false;
    // BUGFIX: hier NIET loadCacheStats() (een nieuwe cached_options-aanroep,
    // dus een verse KV.list()) gebruiken — Workers KV is "eventually
    // consistent" en een list() vlak na een bulkverwijdering van
    // honderden keys kan nog even de oude staat teruggeven (in de praktijk
    // tot de volgende page-load/F5). We weten hier al zeker dat de cache
    // leeg is (het is precies wat cache_reset net deed), dus de weergave
    // rechtstreeks bijwerken i.p.v. herbevragen voorkomt die verwarrende
    // korte terugval naar het oude aantal.
    cacheStats.textContent = 'Cache is momenteel leeg (0 gecachete opmerkingen).';
  } catch (err) {
    cacheStatus.textContent = 'Wissen mislukt: ' + err.message;
    cacheStatus.className = 'status err';
    cacheResetBtn.disabled = false;
  }
});

// ============================================================
// Fase 5: gecachete weergave voor de "user"-rol — filters op reeds
// geanalyseerde data (Fase 4-cache), zonder dat er ooit iets opgeladen of
// een nieuwe AI-analyse gestart moet worden. Hergebruikt bewust dezelfde
// render-functies als het admin-pad (renderResults/buildGlobalOverview/
// renderTopicDomains e.a.) door er een "agg"/"aiCategories" van dezelfde
// vorm voor op te bouwen. Sinds 14/09 is dat een volledig beeld: er zijn geen
// verhalende AI-teksten meer (die werden per analyse gegenereerd, nooit
// bewaard en dus nooit zichtbaar voor een user — ze zijn daarom helemaal uit
// het schema gehaald, wat meteen output-tokens scheelt). Alles wat getoond
// wordt — cijfers, thema's, prospect-classificatie, EUR-waardes — komt uit de
// KV.
// ============================================================
async function loadUserView() {
  userViewStatus.textContent = '';
  try {
    const { ok, status, data } = await authRequest({ mode: 'cached_options' });
    if (status === 401 || status === 403) {
      showLogin(status === 401 ? 'Sessie verlopen — log opnieuw in.' : 'Geen toegang.');
      return;
    }
    if (!ok || !data.hasData) {
      userPlaceholderCard.hidden = false;
      userViewCard.hidden = true;
      if (!ok) {
        document.getElementById('userPlaceholder').textContent =
          'Kon de beschikbare data niet laden: ' + ((data && data.error) || 'onbekende fout') + '.';
      }
      return;
    }
    userPlaceholderCard.hidden = true;
    userViewCard.hidden = false;
    userFilterRegio.innerHTML = '<option value="">Alle</option>' + data.regios.map((r) => `<option value="${escapeAttr(r)}">${escapeHtml(r)}</option>`).join('');
    userFilterRep.innerHTML = '<option value="">Alle</option>' + data.reps.map((r) => `<option value="${escapeAttr(r)}">${escapeHtml(r)}</option>`).join('');
    userFilterKlantList.innerHTML = data.klanten.map((k) => `<option value="${escapeAttr(k)}"></option>`).join('');
  } catch (err) {
    userPlaceholderCard.hidden = false;
    userViewCard.hidden = true;
    document.getElementById('userPlaceholder').textContent = 'Kon de beschikbare data niet laden: ' + err.message + '.';
  }
}

// Gedeeld door de user-rol-kaart (userViewBtn hieronder) én de admin-
// "Filteren"-knop (analyzeBtn, verderop) — dit zijn intussen exact
// dezelfde actie: regio/rep/klant kiezen en de KV-cache bevragen. Bouwt
// zonder nieuwe AI-aanroep een agg/aiCategories op uit de cache en rendert
// die met de bestaande render-functies (renderResults/buildGlobalOverview)
// — enkel de verhalende AI-tekst ontbreekt (nooit per opmerking gecached,
// zie Fase 4), ook wanneer er geen filter gekozen is: "Filteren" leest
// altijd uit de cache, ook meteen na een "Opladen" — geen shortcut naar
// het net getoonde volledige resultaat, voor één consistent gedrag.
// Gooit '__handled__' bij 401/403 (showLogin is dan al aangeroepen) zodat
// de aanroeper dat geval overslaat.
// De Worker geeft de gecachete opmerkingen per pagina terug (zie
// CACHE_PAGE_SIZE): Cloudflare laat maar een beperkt aantal KV-leesbewerkingen
// per aanvraag toe. Hier halen we pagina na pagina op tot alles binnen is en
// voegen we ze samen — vroeger werd er gewoon afgekapt op 800, met stilzwijgend
// onvolledige cijfers als gevolg.
const MAX_CACHE_PAGES = 40;
async function renderCachedFilter(regio, rep, klant, dateFrom, dateTo, onProgress) {
  const data = { categories: {}, perMaand: {}, visitCount: 0, visitsGeschat: false, total: 0, matched: 0 };
  let cursor = null;
  let paginas = 0;
  do {
    const res = await authRequest({
      mode: 'cached_results',
      regio,
      rep,
      klant,
      dateFrom: dateFrom || '',
      dateTo: dateTo || '',
      cursor,
    });
    if (res.status === 401 || res.status === 403) {
      showLogin(res.status === 401 ? 'Sessie verlopen — log opnieuw in.' : 'Geen toegang.');
      throw new Error('__handled__');
    }
    if (!res.ok) {
      throw new Error((res.data && res.data.error) || 'Laden mislukt.');
    }
    const d = res.data || {};
    for (const [cat, bron] of Object.entries(d.categories || {})) {
      if (!data.categories[cat]) {
        data.categories[cat] = { customers: [], topic_tags: [], customer_sentiments: [], prospects: { customers: [], signals: [], potentialSum: 0 } };
      }
      const doel = data.categories[cat];
      doel.customers.push(...(bron.customers || []));
      doel.topic_tags.push(...(bron.topic_tags || []));
      doel.customer_sentiments.push(...(bron.customer_sentiments || []));
      const bp = bron.prospects || {};
      doel.prospects.customers.push(...(bp.customers || []));
      doel.prospects.signals.push(...(bp.signals || []));
      doel.prospects.potentialSum += bp.potentialSum || 0;
    }
    // Bezoeken worden enkel op de eerste pagina geteld (ze komen uit een
    // aparte, goedkope telling op metadata).
    if (d.perMaand && Object.keys(d.perMaand).length) data.perMaand = d.perMaand;
    if (d.visitCount) data.visitCount = d.visitCount;
    if (d.visitsGeschat) data.visitsGeschat = true;
    data.total += d.total || 0;
    data.matched += d.matched || 0;
    cursor = d.nextCursor || null;
    paginas++;
    if (onProgress) onProgress(data.matched, !!cursor);
  } while (cursor && paginas < MAX_CACHE_PAGES);

  const agg = {};
  const aiCategories = {};
  for (const cat of Object.keys(CATEGORY_LABELS)) {
    const c = data.categories[cat] || { customers: [], topic_tags: [], customer_sentiments: [], prospects: { customers: [], signals: [] } };
    const pros = c.prospects || { customers: [], signals: [] };
    agg[cat] = {
      existing: { customers: c.customers },
      prospecting: { customers: pros.customers, potentialSum: pros.potentialSum || 0, signals: pros.signals },
    };
    aiCategories[cat] = {
      existing_customers: {
        customer_sentiments: c.customer_sentiments,
        topic_tags: c.topic_tags,
      },
      prospecting: {},
    };
  }
  lastAgg = agg;
  const globalOverview = buildGlobalOverview(agg, aiCategories);
  renderResults(agg, aiCategories, globalOverview);
  renderVisitsChart(data.perMaand, data.visitsGeschat);
  return { matched: data.matched, total: data.total, visitCount: data.visitCount };
}

// Gedeelde klik-afhandeling voor "Filteren" (admin) en "Tonen" (user-rol):
// beide doen exact hetzelfde — regio/rep/klant naar de cache sturen en het
// resultaat renderen — enkel de knop en het statusregeltje verschillen.
async function applyCachedFilter(regio, rep, klant, btnEl, statusEl, dateFrom, dateTo) {
  btnEl.disabled = true;
  statusEl.textContent = 'Filter toepassen (uit cache, geen nieuwe AI-aanroep)...';
  statusEl.className = 'status';
  try {
    const result = await renderCachedFilter(regio, rep, klant, dateFrom, dateTo, (sofar, meer) => {
      if (meer) statusEl.textContent = `Uit cache laden... ${sofar} opmerking(en)`;
    });
    statusEl.textContent =
      `${result.matched} gecachete opmerking(en) gevonden` +
      (result.visitCount ? ` uit ${result.visitCount} bezoekrapport(en)` : '') +
      '.';
    statusEl.className = 'status';
  } catch (err) {
    if (err.message !== '__handled__') {
      statusEl.textContent = 'Filteren mislukt: ' + err.message;
      statusEl.className = 'status err';
    }
  } finally {
    btnEl.disabled = false;
  }
}

const userFilterVan = document.getElementById('userFilterVan');
const userFilterTot = document.getElementById('userFilterTot');
userViewBtn.addEventListener('click', () => {
  const van = userFilterVan.value;
  const tot = userFilterTot.value;
  if (van && tot && van > tot) {
    userViewStatus.textContent = '"Vanaf" ligt na "tot en met" — draai de datums om.';
    userViewStatus.className = 'status err';
    return;
  }
  applyCachedFilter(
    userFilterRegio.value,
    userFilterRep.value,
    userFilterKlant.value.trim(),
    userViewBtn,
    userViewStatus,
    van,
    tot
  );
});

// "Opladen": verwerkt en analyseert ALLE ingelezen rijen (parsedRows,
// ongefilterd) via AI, per categorie — dit is de enige stap die AI-kost
// met zich meebrengt. De classificatie per opmerking wordt daarbij door de
// Worker in de KV-cache weggeschreven (zie worker.js). Nadien bouwt dit de
// regio/rep/klant-filters op en toont meteen het volledige resultaat; de
// "Filteren"-knop hieronder herschikt vanaf dan enkel nog uit de cache,
// zonder nieuwe AI-aanroep (zie renderCachedFilter/applyCachedFilter).
filterBtn.addEventListener('click', async () => {
  filterBtn.disabled = true;
  setAnalyzeStatus('');
  setStatus('Cache voorbereiden...');

  const agg = buildAggregation(parsedRows);
  lastAgg = agg;
  cacheWriteStats = { attempted: 0, succeeded: 0, failed: 0, firstError: '' };
  aiResponseIssues = {};
  aiUsageStats = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0, limits: null, minOutputRemaining: null, startedAt: Date.now() };

  const cats = Object.keys(CATEGORY_LABELS);

  // Kostenrem: een opmerking die al geanalyseerd is, hoeft niet opnieuw naar de
  // AI. De cachesleutel is een hash van klant + datum + opmerking, dus
  // ongewijzigde tekst geeft gegarandeerd dezelfde sleutel; wijzigt de tekst,
  // dan verandert de hash mee en wordt ze vanzelf opnieuw geanalyseerd.
  // Vroeger wiste elke "Opladen" eerst alles van de betrokken bestanden en
  // betaalde je dus telkens de volle heranalyse — drie keer hetzelfde bestand
  // opladen kostte drie keer de volle prijs.
  const sourceFiles = [...new Set(parsedRows.map((r) => r['sourceFile']).filter(Boolean))];
  const candidateKeys = [];
  for (const cat of cats) {
    const alle = [
      ...remarksForAi(agg[cat].existing.customers, cat),
      ...remarksForAi(agg[cat].prospecting.customers, cat),
    ];
    for (const r of alle) {
      if (r.key && r.sourceFile) candidateKeys.push(`remark:${r.sourceFile}:${cat}:${r.key}`);
    }
  }
  let cachedKeys = new Set();
  let onvolledigHersteld = 0;
  if (sourceFiles.length) {
    setStatus('Cache nakijken...');
    const { ok, status, data } = await authRequest({ mode: 'cache_sync', files: sourceFiles, keys: candidateKeys });
    if (status === 401 || status === 403) {
      showLogin(status === 401 ? 'Sessie verlopen — log opnieuw in.' : 'Geen toegang.');
      filterBtn.disabled = false;
      return;
    }
    if (!ok) {
      setStatus('Kon cache niet voorbereiden: ' + ((data && data.error) || 'onbekende fout') + '.', true);
      filterBtn.disabled = false;
      return;
    }
    cachedKeys = new Set((data && data.existing) || []);
    onvolledigHersteld = (data && data.incomplete) || 0;
  }
  const hergebruikt = cachedKeys.size;
  const nieuw = candidateKeys.length - hergebruikt;

  // Records die al gecachet zijn worden niet opnieuw geanalyseerd, en dus ook
  // niet herschreven. Velden die uit de Excel komen (vandaag: de EUR-waarde)
  // zouden daardoor nooit in oudere records belanden. Die vullen we hier bij,
  // zonder AI — in stukken, want elke record kost een lees- en een
  // schrijfbewerking en Cloudflare begrenst het aantal per aanvraag.
  const teVerrijken = [];
  for (const cat of cats) {
    const alle = [
      ...remarksForAi(agg[cat].existing.customers, cat),
      ...remarksForAi(agg[cat].prospecting.customers, cat),
    ];
    for (const r of alle) {
      if (!r.key || !r.sourceFile || !r.potential) continue;
      const naam = `remark:${r.sourceFile}:${cat}:${r.key}`;
      if (cachedKeys.has(naam)) teVerrijken.push({ name: naam, potential: r.potential });
    }
  }
  let verrijkt = 0;
  for (let i = 0; i < teVerrijken.length; i += 150) {
    const res = await authRequest({ mode: 'enrich_records', updates: teVerrijken.slice(i, i + 150) });
    verrijkt += (res.data && res.data.patched) || 0;
  }

  // Elk bezoekrapport apart registreren, los van de AI-analyse. De
  // "remark:"-records bestaan enkel voor opmerkingen met bruikbare tekst per
  // categorie, dus bezoeken met een lege of administratieve notitie zaten
  // nergens — waardoor de grafiek er structureel te weinig toonde (gemeten op
  // juni 2026: 156 in beeld tegenover 211 in de Excel). Geen AI-kost.
  const visits = parsedRows
    .filter((r) => r['sourceFile'])
    .map((r) => ({
      // Zelfde sleutelopbouw als in buildAggregation (Remark + Re samengevoegd),
      // zodat een bezoek en zijn opmerking-records dezelfde identiteit delen.
      key: remarkCacheKey(r['name'], r['date'], [r['remark'], r['re']].filter(Boolean).join(' — ')),
      sourceFile: r['sourceFile'],
      klant: r['name'] || '',
      rep: r['rep'] || '',
      regio: r['regio'] || '',
      dateIso: toIsoDate(r['date'], r['sourceFile']),
      kind: isExisting(r) ? 'existing' : 'prospect',
    }));
  let bezoekenGeregistreerd = 0;
  if (visits.length) {
    // Mislukt dit, dan blijft de analyse gewoon doorgaan: enkel de grafiek is
    // dan onvolledig.
    const res = await authRequest({ mode: 'store_visits', visits });
    bezoekenGeregistreerd = (res.data && res.data.stored) || 0;
  }
  // De voortgangsbalk en "X/Y categorieën verwerkt"-tekst zitten in
  // filterCard (Stap 2) — die kaart moet dus al zichtbaar zijn VOORDAT
  // de analyse start, anders update showProgress() een balk die nog
  // verstopt zit en lijkt "Analyse loopt..." urenlang stil te staan.
  filterCard.hidden = false;
  setCollapsed(filterBody, filterToggle, filterSummary, false);
  showProgress(0, cats.length);
  setStatus('Analyse loopt...');
  await warmPromptCache();

  let done = 0;
  const results = await Promise.all(cats.map(async (cat) => {
    const v = agg[cat];
    try {
      const analysis = await analyzeCategory(cat, v, cachedKeys);
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
    else if (err) failed.push(`${CATEGORY_LABELS[cat]} (${err})`);
    // analysis === null zonder fout = niets nieuws te analyseren voor deze
    // categorie; de cijfers komen dan volledig uit de cache.
  }

  // Regio/rep/klant-filters opbouwen uit de volledige (ongefilterde)
  // dataset, zodat "Filteren" hieronder meteen bruikbaar is.
  const regios = [...new Set(parsedRows.map((r) => r['regio']).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const reps = [...new Set(parsedRows.map((r) => r['rep']).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const klanten = [...new Set(parsedRows.map((r) => r['name']).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  filterRegio.innerHTML = '<option value="">Alle</option>' + regios.map((r) => `<option value="${escapeAttr(r)}">${escapeHtml(r)}</option>`).join('');
  filterRep.innerHTML = '<option value="">Alle</option>' + reps.map((r) => `<option value="${escapeAttr(r)}">${escapeHtml(r)}</option>`).join('');
  filterKlantList.innerHTML = klanten.map((k) => `<option value="${escapeAttr(k)}"></option>`).join('');
  filterKlant.value = '';
  filterCard.hidden = false;
  setCollapsed(filterBody, filterToggle, filterSummary, false);
  updateFilterStatus();

  // Categorieën die volledig uit de cache kwamen hebben deze run geen
  // AI-resultaat, dus renderResults() zou ze leeg tonen terwijl de data wél
  // bestaat. Zodra er iets hergebruikt is, tonen we daarom het volledige beeld
  // uit de cache (zoals "Filteren" doet) i.p.v. enkel wat nu vers is.
  const uitCache = hergebruikt > 0;
  const globalOverview = buildGlobalOverview(agg, aiCategories);
  if (uitCache) {
    try {
      await renderCachedFilter('', '', '', '', '');
    } catch (err) {
      if (err.message !== '__handled__') renderResults(agg, aiCategories, globalOverview);
    }
  } else {
    renderResults(agg, aiCategories, globalOverview);
  }
  hideProgress();

  // Cache-schrijffouten mogen de analyse zelf niet blokkeren (zie
  // fetchAnalysisBatch), maar moeten wél zichtbaar zijn — anders lijkt
  // "Opladen" geslaagd terwijl "Filteren" nadien niets (compleets) toont.
  let cacheNote = '';
  if (cacheWriteStats.attempted) {
    if (cacheWriteStats.failed) {
      cacheNote = ` Let op: cache-opslag mislukte voor ${cacheWriteStats.failed}/${cacheWriteStats.attempted} opmerking(en)` +
        (cacheWriteStats.firstError ? ` (${cacheWriteStats.firstError})` : '') +
        ' — "Filteren" zal daardoor onvolledig zijn tot een nieuwe "Opladen".';
    }
  } else if (!hergebruikt) {
    cacheNote = ' Let op: er werd niets in de cache weggeschreven — "Filteren" zal leeg blijven tot een nieuwe "Opladen".';
  }
  // Diagnose (i.o.v. Gwenn): laat zien of de AI voor een categorie geen
  // (volledige) customer_sentiments-lijst teruggaf — bv. door de
  // max_tokens-limiet (stop_reason "max_tokens") of een ander onvolledig
  // antwoord. Dit is precies het soort probleem dat Screens/Home
  // herhaaldelijk als "0 signalen" liet tonen, zonder dat "Opladen" zelf
  // faalde (missingIds/stop_reason werden voorheen enkel gelogd, nooit
  // getoond — zie worker.js).
  const aiNotes = [];
  for (const [cat, info] of Object.entries(aiResponseIssues)) {
    if (info.missingIds > 0 || info.stopReasons.size) {
      const reasonTxt = info.stopReasons.size ? ` (stop_reason: ${[...info.stopReasons].join(', ')})` : '';
      const d0 = (info.details && info.details[0]) || null;
      const splitsing = d0
        ? ` [klanten ${d0.existingMissing}/${d0.existingTotal}, prospects ${d0.prospectMissing}/${d0.prospectTotal};` +
          ` AI gaf ${d0.sentimentsTerug} sentiment(en), ${d0.tagsTerug} tag(s), ${d0.signalsTerug} signaal/signalen;` +
          ` verwacht ${d0.idsVerwacht.join(',')} — terug ${d0.idsTerug.join(',') || '(niets)'}]`
        : '';
      aiNotes.push(`${CATEGORY_LABELS[cat]}: ${info.missingIds}/${info.totalIds} opmerking(en) zonder classificatie${reasonTxt}${splitsing}`);
    }
  }
  const aiNote = aiNotes.length ? ` Let op — onvolledig AI-antwoord voor: ${aiNotes.join('; ')}.` : '';
  // AI-verbruik + accountlimiet tonen: zo is meteen zichtbaar of een trage run
  // aan de hoeveelheid werk lag of aan de rate limit van het Anthropic-account.
  // Niet enkel tonen wanneer er hergebruik was: net na een cache-reset is
  // hergebruikt 0 en verdween zo ook het aantal nieuw geanalyseerde
  // opmerkingen — precies het cijfer dat je dan wil zien.
  const hergebruikNote = (hergebruikt || nieuw)
    ? (hergebruikt
      ? ` ${hergebruikt} opmerking(en) stonden al in de cache en kostten niets; ${nieuw} nieuw geanalyseerd.`
      : ` ${nieuw} opmerking(en) nieuw geanalyseerd (niets uit de cache).`)
    : '';
  const bijwerkDelen = [];
  if (bezoekenGeregistreerd) bijwerkDelen.push(`${bezoekenGeregistreerd} bezoek(en) geregistreerd`);
  if (onvolledigHersteld) bijwerkDelen.push(`${onvolledigHersteld} eerder onvolledig gebleven opmerking(en) opnieuw aangeboden`);
  if (verrijkt) bijwerkDelen.push(`${verrijkt} record(s) aangevuld met een €-waarde`);
  const bijwerkNote = bijwerkDelen.length ? ` Zonder AI-kost: ${bijwerkDelen.join(' en ')}.` : '';
  let usageNote = '';
  if (aiUsageStats.calls) {
    const duurSec = aiUsageStats.startedAt ? Math.round((Date.now() - aiUsageStats.startedAt) / 1000) : 0;
    const duurTxt = duurSec >= 60 ? `${Math.floor(duurSec / 60)}m${String(duurSec % 60).padStart(2, '0')}s` : `${duurSec}s`;
    // Prijzen per miljoen tokens: input $3, cache-write $3,75, cache-read
    // $0,30, output $15. Cache-tokens staan los van "input_tokens".
    const kosten =
      (aiUsageStats.inputTokens / 1e6) * 3 +
      (aiUsageStats.cacheWriteTokens / 1e6) * 3.75 +
      (aiUsageStats.cacheReadTokens / 1e6) * 0.3 +
      (aiUsageStats.outputTokens / 1e6) * 15;
    usageNote = ` Duur: ${duurTxt} voor ${aiUsageStats.calls} AI-aanroep(en). ` +
      `Tokens: ${aiUsageStats.inputTokens.toLocaleString('nl-BE')} input, ` +
      `${aiUsageStats.outputTokens.toLocaleString('nl-BE')} output`;
    if (aiUsageStats.cacheReadTokens || aiUsageStats.cacheWriteTokens) {
      usageNote += `, ${aiUsageStats.cacheReadTokens.toLocaleString('nl-BE')} uit cache gelezen ` +
        `(${aiUsageStats.cacheWriteTokens.toLocaleString('nl-BE')} weggeschreven)`;
    }
    usageNote += ` — ± $${kosten.toFixed(2)}.`;
  }
  if (failed.length) {
    setStatus(`Analyse deels mislukt voor: ${failed.join(', ')}. De andere categorieën zijn wel bijgewerkt.${cacheNote}${aiNote}${hergebruikNote}${bijwerkNote}${usageNote}`, true);
  } else {
    setStatus(`Analyse voltooid op basis van ${parsedRows.length} rijen. Gebruik hieronder de filters en klik op "Filteren" om de weergave te verfijnen — dat kost geen nieuwe AI-aanroep.${cacheNote}${aiNote}${hergebruikNote}${bijwerkNote}${usageNote}`, !!cacheNote || !!aiNote);
  }
  filterBtn.disabled = false;
  // Analyse is klaar — de upload-kaart mag nu plaats maken.
  setCollapsed(uploadBody, uploadToggle, uploadSummary, true, uploadSummaryText());
  loadCacheStats();
});

filterRegio.addEventListener('change', updateFilterStatus);
filterRep.addEventListener('change', updateFilterStatus);
filterKlant.addEventListener('input', updateFilterStatus);
filterVan.addEventListener('change', updateFilterStatus);
filterTot.addEventListener('change', updateFilterStatus);

// Rij voldoet aan filter Regio EN filter Sales Rep EN filter Klant — een
// leeg filter ("Alle") legt geen voorwaarde op. Klant is een vrij
// tekstveld (met datalist-suggesties) maar moet, om als filter te gelden,
// exact overeenkomen met een klantnaam uit de data — anders levert dat
// gewoon 0 rijen op, zichtbaar via de live teller hieronder.
function matchesFilters(row) {
  const regioVal = filterRegio.value;
  const repVal = filterRep.value;
  const klantVal = filterKlant.value.trim();
  if (regioVal && row['regio'] !== regioVal) return false;
  if (repVal && row['rep'] !== repVal) return false;
  if (klantVal && row['name'] !== klantVal) return false;
  const van = filterVan.value;
  const tot = filterTot.value;
  const d = toIsoDate(row['date'], row['sourceFile']);
  if (van && (!d || d < van)) return false;
  if (tot && (!d || d > tot)) return false;
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
// De export levert datums als "DD-MM-JJJJ". Datumvelden in de browser en een
// zinvolle sortering/groepering per maand werken met "JJJJ-MM-DD", dus bewaren
// we die genormaliseerde vorm apart naast de originele tekst. Zonder dit zou
// een periodefilter stilzwijgend verkeerde rijen tonen (tekstvergelijking op
// "14-09-2026" sorteert op dag, niet op jaar).
// Het jaartal staat NIET in de datumkolom: de export schrijft "Tue 31-03".
// Het jaar zit enkel in de bestandsnaam ("history_BE_03-2026.xls"), dus dat is
// de enige betrouwbare bron. parseReportDate valt zonder jaartal terug op het
// HUIDIGE jaar, wat stilzwijgend fout gaat zodra je een export van vorig jaar
// oplaadt — vandaar dat we hier het jaar uit de bestandsnaam halen.
function toIsoDate(str, sourceFile) {
  const m = String(str || '').match(/(\d{2})-(\d{2})/);
  if (!m) return '';
  const dag = m[1];
  const maand = parseInt(m[2], 10);
  const f = String(sourceFile || '').match(/_(\d{2})-(\d{4})\./);
  if (!f) {
    // Geen bruikbare bestandsnaam: terugvallen op het gedrag van
    // parseReportDate (huidig jaar) i.p.v. de datum helemaal te laten vallen.
    const d = parseReportDate(str);
    if (!d) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const bestandsMaand = parseInt(f[1], 10);
  let jaar = parseInt(f[2], 10);
  // Een maandexport kan een rapport van eind vorige maand bevatten. Loopt dat
  // over een jaargrens (bestand januari, rapport december), dan hoort het bij
  // het vorige jaar.
  if (bestandsMaand === 1 && maand === 12) jaar -= 1;
  else if (bestandsMaand === 12 && maand === 1) jaar += 1;
  return `${jaar}-${String(maand).padStart(2, '0')}-${dag}`;
}

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

// Status van de AI-analyse hoort naast de "Filteren"-knop (in filterCard,
// voorheen "Analyseren"), niet naast de "Opladen"-knop in de upload-kaart —
// anders lijkt het alsof de voortgang bij de verkeerde knop hoort (zie
// screenshot van Gwenn, oorspronkelijk over "Analyseren" vs. "Filteren").
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
  const regioLabel = filterRegio.value || 'alle regio\'s';
  const repLabel = filterRep.value || 'alle reps';
  const klantLabel = filterKlant.value || 'alle klanten';
  return `Filter: ${regioLabel} · ${repLabel} · ${klantLabel}${filterStatus.textContent ? ' — ' + filterStatus.textContent : ''}`;
}

function usersSummaryText() {
  const base = usersFname.textContent || 'Geen bestand gekozen';
  return usersStatus.textContent ? `${base} — ${usersStatus.textContent}` : base;
}

uploadToggle.addEventListener('click', () => {
  setCollapsed(uploadBody, uploadToggle, uploadSummary, !uploadBody.hidden, uploadSummaryText());
});
filterToggle.addEventListener('click', () => {
  setCollapsed(filterBody, filterToggle, filterSummary, !filterBody.hidden, filterSummaryText());
});
usersToggle.addEventListener('click', () => {
  setCollapsed(usersBody, usersToggle, usersSummary, !usersBody.hidden, usersSummaryText());
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
  // BUGFIX (analyse i.o.v. Gwenn op 3 maanden BE-data): "First visit to
  // potential customer" is een eerste bezoek aan een PROSPECT — even
  // duidelijk geen bestaande klant als "Follow up visit to potential
  // customer" hieronder, maar ontbrak hier. Zonder deze regel werden 21
  // van de 25 rijen met deze reden toch als "bestaande klant" meegeteld,
  // in elke categorie.
  if (
    reason.includes('prospect') ||
    reason.includes('follow up visit to potential') ||
    reason.includes('first visit to potential')
  ) {
    return false;
  }
  return true;
}

// Fase 4: stabiele cache-sleutel per opmerking (klant + datum + tekst),
// zelfde principe als dedupeKey hierboven maar op de al samengevoegde
// remark/re-tekst — dit is de sleutel waaronder de Worker de AI-classificatie
// van deze opmerking in de KV-cache bewaart (zie cache_invalidate_files/
// admin_upsert_users-achtige nieuwe modes in worker.js). Geen categorie in
// de sleutel zelf: dat wordt in de Worker toegevoegd, want één opmerking
// kan (met per-categorie gefilterde tekst) in meerdere categorieën
// terechtkomen.
// Kleine, deterministische 32-bit FNV-1a-variant (sync, geen Web Crypto
// nodig). Twee onafhankelijke varianten (andere seed) samengevoegd geven
// een 64-bit-achtige, vaste-lengte hex-sleutel — botsingen zijn voor deze
// dataset (tienduizenden opmerkingen) praktisch verwaarloosbaar, en de
// sleutel wordt nergens uitgelezen/geparsed, enkel als opaque identifier
// gebruikt (zie r.key in worker.js).
function hash32(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0; // FNV-prime
  }
  return h >>> 0;
}

// Cache-sleutel per opmerking (klant + datum + tekst, genormaliseerd) —
// gebruikt als deel van de KV-key in worker.js (remark:<bestand>:<cat>:<key>).
// BUGFIX: eerder werd de genormaliseerde tekst hier ZELF als sleutel
// gebruikt — bij een lange opmerking (of met veel meerbyte UTF-8-tekens)
// overschreed de resulterende KV-key al snel Cloudflare's limiet van 512
// bytes per key, waardoor die cache-write stil faalde ("KV PUT failed: ...
// exceeds key length limit of 512"). Een hash geeft altijd een vaste,
// korte lengte, ongeacht hoe lang de opmerking is.
function remarkCacheKey(name, date, remark) {
  const n = (name || '').trim().toLowerCase();
  const d = (date || '').trim().toLowerCase();
  const s = (remark || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const combined = `${n}|${d}|${s}`;
  const h1 = hash32(combined, 0x811c9dc5);
  const h2 = hash32(combined, 0x1000193 ^ combined.length);
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
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
    // "key"/"sourceFile" zijn nieuw (Fase 4): nodig om de AI-classificatie
    // van deze opmerking in de Worker-KV te cachen en bij een heropload van
    // hetzelfde bestand de oude cache-entries ervan te kunnen vervangen.
    const detail = {
      name,
      remark,
      rep: row['rep'] || row['user'] || '',
      date: row['date'] || '',
      dateIso: toIsoDate(row['date'], row['sourceFile']),
      type: row['type'] || '',
      status: row['status'] || '',
      regio: row['regio'] || '',
      key: remarkCacheKey(name, row['date'], remark),
      sourceFile: row['sourceFile'] || '',
    };
    for (const cat of rowCats) {
      if (existing) {
        // Ook bij bestaande klanten de EUR-waarde meegeven: ze staat in
        // dezelfde Potential-kolom en hoort in de KV thuis, zodat de
        // user-weergave er ook over beschikt.
        agg[cat].existing.customers.push({ ...detail, potential: potentialForCategory(row, cat) });
      } else {
        // Het potentieel hangt aan de rij, maar wordt per categorie bepaald
        // (productspecifieke kolom met terugval op de algemene "Potential").
        // We hangen het aan de opmerking zelf, zodat de Worker het kan
        // bewaren en de weergave uit de cache het opnieuw kan optellen —
        // anders toont "Filteren" overal EUR 0.
        const p = potentialForCategory(row, cat);
        agg[cat].prospecting.customers.push({ ...detail, potential: p });
        agg[cat].prospecting.potentialSum += p;
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
    .map((c) => ({
      name: c.name,
      remark: filterRemarkForCategory(c.remark, targetCat),
      key: c.key,
      sourceFile: c.sourceFile,
      rep: c.rep,
      regio: c.regio,
      date: c.date,
      type: c.type,
      status: c.status,
      dateIso: c.dateIso || '',
      potential: c.potential || 0,
    }))
    .filter((c) => c.remark);
}

// Verdeelt een array in stukken van max. `size` elementen. Een lege array
// geeft [[]] terug (één lege batch) zodat een categorie zonder opmerkingen
// nog steeds als één (leeg) verzoek naar de AI gaat, zoals voorheen.
// Verdeelt in batches op TWEE grenzen: aantal opmerkingen én totale
// tekstlengte. Alleen op aantal tellen ging mis zodra opmerkingen lang zijn:
// in history_BE_04-2026.xls bleken de Home-opmerkingen volledige gestructureerde
// bezoekverslagen van tot 2.947 tekens (mediaan elders: ~320). Twaalf daarvan in
// één aanroep is ruim 8.000 tekens dichte tekst; het model liep tegen de
// 90-secondengrens en gaf de uitputtende lijst niet meer rond — 22 van de 22
// opmerkingen kwamen zonder classificatie terug. De last zit dus in tekens, niet
// in stuks. Eén opmerking die op zichzelf al over de grens gaat, krijgt gewoon
// een eigen batch.
const BATCH_CHAR_LIMIT = 4000;
function chunkArray(arr, size) {
  if (!arr.length) return [arr];
  const chunks = [];
  let huidig = [];
  let tekens = 0;
  for (const item of arr) {
    const lengte = ((item && item.remark) || '').length;
    if (huidig.length && (huidig.length >= size || tekens + lengte > BATCH_CHAR_LIMIT)) {
      chunks.push(huidig);
      huidig = [];
      tekens = 0;
    }
    huidig.push(item);
    tekens += lengte;
  }
  if (huidig.length) chunks.push(huidig);
  return chunks;
}

// Eén AI-aanroep voor één batch (deel van) een categorie.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Alle categorieën (en binnen elke categorie, alle batches) vuren
// gelijktijdig naar de Worker/Anthropic — bij grote datasets kan dat al
// snel 10-15+ gelijktijdige AI-aanroepen geven. Een tijdelijke
// rate-limit/overload-fout (429/529) of server-fout (5xx) op één daarvan
// mag dan niet meteen de hele batch (en dus mogelijk de hele categorie,
// zie analyzeCategory) laten mislukken — vandaar een paar nieuwe pogingen
// met oplopende wachttijd voor je opgeeft.
const BATCH_MAX_RETRIES = 3;

async function fetchAnalysisBatch(cat, existingRemarks, prospectingRemarks, potentialSum, attempt = 0) {
  let res;
  try {
    res = await fetch(ANALYZE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        category: CATEGORY_LABELS[cat],
        existing: { remarks: existingRemarks },
        prospecting: { remarks: prospectingRemarks, potentialSum },
      }),
    });
  } catch (networkErr) {
    // fetch zelf kan falen (netwerkhik, tijdelijk niet bereikbaar) nog vóór
    // er al een HTTP-statuscode is — ook dat verdient een nieuwe poging.
    if (attempt < BATCH_MAX_RETRIES) {
      await sleep(1000 * 2 ** attempt);
      return fetchAnalysisBatch(cat, existingRemarks, prospectingRemarks, potentialSum, attempt + 1);
    }
    throw new Error(`netwerkfout: ${networkErr.message}`);
  }
  if (res.status === 401 || res.status === 403) {
    // Sessie verlopen/ongeldig, of geen rechten — retryen heeft hier geen
    // zin. Toon meteen het inlogscherm i.p.v. dit als een gewone fout per
    // batch/categorie te laten falen.
    showLogin(res.status === 401 ? 'Sessie verlopen — log opnieuw in.' : 'Geen toegang.');
    throw new Error(res.status === 401 ? 'sessie verlopen' : 'geen toegang');
  }
  if (!res.ok) {
    const transient = res.status === 429 || res.status === 529 || res.status >= 500;
    if (transient && attempt < BATCH_MAX_RETRIES) {
      await sleep(1000 * 2 ** attempt);
      return fetchAnalysisBatch(cat, existingRemarks, prospectingRemarks, potentialSum, attempt + 1);
    }
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
  if (data.cache) {
    cacheWriteStats.attempted += data.cache.attempted || 0;
    cacheWriteStats.succeeded += data.cache.succeeded || 0;
    cacheWriteStats.failed += data.cache.failed || 0;
    if (data.cache.failed && !cacheWriteStats.firstError) {
      cacheWriteStats.firstError = data.cache.firstError || '';
    }
  }
  if (data.diagnostics && data.diagnostics.totalIds) {
    const d = data.diagnostics;
    if (!aiResponseIssues[cat]) aiResponseIssues[cat] = { missingIds: 0, totalIds: 0, stopReasons: new Set() };
    aiResponseIssues[cat].missingIds += d.missingIds || 0;
    aiResponseIssues[cat].totalIds += d.totalIds || 0;
    if (d.stopReason && d.stopReason !== 'tool_use') aiResponseIssues[cat].stopReasons.add(d.stopReason);
    if (d.detail && (d.detail.existingMissing || d.detail.prospectMissing)) {
      // Eén regel per problematische aanroep, zichtbaar in de console — genoeg
      // om te zien of de lijsten leeg waren dan wel gevuld met andere ids.
      console.warn(`[${cat}] onvolledig antwoord`, d.detail);
      if (!aiResponseIssues[cat].details) aiResponseIssues[cat].details = [];
      aiResponseIssues[cat].details.push(d.detail);
    }
  }
  if (data.diagnostics) {
    const d = data.diagnostics;
    aiUsageStats.calls++;
    aiUsageStats.inputTokens += d.inputTokens || 0;
    aiUsageStats.outputTokens += d.outputTokens || 0;
    aiUsageStats.cacheReadTokens += d.cacheReadTokens || 0;
    aiUsageStats.cacheWriteTokens += d.cacheWriteTokens || 0;
    if (d.rateLimits) {
      aiUsageStats.limits = d.rateLimits;
      const rem = parseInt(d.rateLimits.outputRemaining, 10);
      if (!Number.isNaN(rem) && (aiUsageStats.minOutputRemaining === null || rem < aiUsageStats.minOutputRemaining)) {
        aiUsageStats.minOutputRemaining = rem;
      }
    }
  }
  return data.analysis;
}

// Voegt de analyses van meerdere batches van dezelfde categorie samen tot
// één object met dezelfde vorm als een los batch-resultaat, zodat
// buildGlobalOverview/renderResults ongewijzigd kunnen blijven. Lijstvelden
// (customer_sentiments, topic_tags, prospect_signals) worden geconcateneerd —
// gelijkaardige topic_tags uit verschillende batches kunnen dus als
// aparte entries blijven staan i.p.v. samengevoegd tot één groep (geen
// semantische deduplicatie tussen batches).
function mergeCategoryAnalyses(analyses) {
  const ec = analyses.map((a) => a.existing_customers || {});
  const pr = analyses.map((a) => a.prospecting || {});
  return {
    existing_customers: {
      customer_sentiments: ec.flatMap((e) => e.customer_sentiments || []),
      topic_tags: ec.flatMap((e) => e.topic_tags || []),
    },
    prospecting: {
      prospect_signals: pr.flatMap((p) => p.prospect_signals || []),
    },
  };
}

// 13/09, zesde aanpassing: geen enkele vaste BATCH_SIZE bleek voor alle
// categorieën/maanden veilig — het volume per categorie wisselt te veel
// (de ene keer is Home de uitschieter, een andere keer Screens, of
// Rolluiken/Luifels/Pergola samen). In plaats van dat globaal te blijven
// raden: als een batch na zijn eigen retries (fetchAnalysisBatch) nog
// steeds mislukt, heeft blindelings hetzelfde nog eens proberen geen zin
// — maar de opmerkingen in twee helften splitsen en elke helft apart
// (met zijn eigen volledige retry-budget) wél: vanzelf kleiner tot het
// binnen de tijd past, specifiek voor die categorie/maand die het nodig
// heeft, i.p.v. overal een grotere marge te nemen.
const MIN_SPLIT_SIZE = 5;
async function analyzeChunkWithSplit(cat, existingChunk, prospectingChunk, potentialSum) {
  try {
    return await limitAnalysisCall(() =>
      fetchAnalysisBatch(cat, existingChunk, prospectingChunk, potentialSum)
    );
  } catch (err) {
    const total = existingChunk.length + prospectingChunk.length;
    if (total <= MIN_SPLIT_SIZE) throw err;
    const halfE = Math.ceil(existingChunk.length / 2);
    const halfP = Math.ceil(prospectingChunk.length / 2);
    const parts = [
      [existingChunk.slice(0, halfE), prospectingChunk.slice(0, halfP)],
      [existingChunk.slice(halfE), prospectingChunk.slice(halfP)],
    ].filter(([e, p]) => e.length || p.length);
    console.warn(`[${cat}] batch van ${total} opmerking(en) mislukte (${err.message}) — opgesplitst in ${parts.length} kleinere pogingen.`);
    const results = await Promise.all(
      parts.map(([e, p]) => analyzeChunkWithSplit(cat, e, p, potentialSum))
    );
    return mergeCategoryAnalyses(results);
  }
}

// Analyseert één categorie. Als er meer dan BATCH_SIZE bruikbare
// opmerkingen zijn (bestaand en/of prospecting, elk apart geteld), wordt
// dat deel in meerdere batches gesplitst die parallel naar de AI gaan; de
// resultaten worden nadien samengevoegd tot één analyse voor de hele
// categorie. Als één batch faalt maar minstens één andere lukt, gaat de
// analyse door op basis van wat wel gelukt is (met een console.warn).
async function analyzeCategory(cat, v, cachedKeys) {
  const alreadyCached = cachedKeys || new Set();
  // Opmerkingen die al in de cache zitten worden niet opnieuw opgestuurd: hun
  // classificatie verandert niet en staat al klaar voor "Filteren".
  const existingAll = remarksForAi(v.existing.customers, cat).filter(
    (r) => !alreadyCached.has(`remark:${r.sourceFile}:${cat}:${r.key}`)
  );
  const prospectingAll = remarksForAi(v.prospecting.customers, cat).filter(
    (r) => !alreadyCached.has(`remark:${r.sourceFile}:${cat}:${r.key}`)
  );
  // Niets nieuws aan beide kanten: dan valt er voor deze categorie niets te
  // vragen aan de AI. Scheelt een volledige (betalende) aanroep.
  if (!existingAll.length && !prospectingAll.length) return null;
  const existingChunks = chunkArray(existingAll, BATCH_SIZE);
  const prospectingChunks = chunkArray(prospectingAll, BATCH_SIZE);
  const batchCount = Math.max(existingChunks.length, prospectingChunks.length);

  const settled = await Promise.allSettled(
    Array.from({ length: batchCount }, (_, i) =>
      analyzeChunkWithSplit(cat, existingChunks[i] || [], prospectingChunks[i] || [], v.prospecting.potentialSum)
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

// "Filteren" (voorheen "Analyseren"): leest ALTIJD uit de cache
// (applyCachedFilter/renderCachedFilter — dezelfde functie als de
// user-rol-kaart), ook direct na een "Opladen" en ook zonder filter
// ("Alle" overal) — bewust geen shortcut naar het net getoonde volledige
// resultaat, voor één consistent gedrag. Kost daarom nooit een nieuwe
// AI-aanroep, maar mist ook altijd de verhalende AI-tekst (die is nooit
// per opmerking gecached, zie Fase 4) — die zie je enkel in het resultaat
// dat "Opladen" zelf meteen toont.
document.getElementById('analyzeBtn').addEventListener('click', async () => {
  const regio = filterRegio.value;
  const rep = filterRep.value;
  const klant = filterKlant.value.trim();
  const van = filterVan.value;
  const tot = filterTot.value;
  if (van && tot && van > tot) {
    analyzeStatus.textContent = '"Vanaf" ligt na "tot en met" — draai de datums om.';
    analyzeStatus.className = 'status err';
    return;
  }
  await applyCachedFilter(regio, rep, klant, analyzeBtn, analyzeStatus, van, tot);
  const periode = van || tot ? ` · periode: ${van || '…'} t/m ${tot || '…'}` : '';
  setCollapsed(filterBody, filterToggle, filterSummary, true,
    `Filter: regio: ${regio || 'alle'} · rep: ${rep || 'alle'} · klant: ${klant || 'alle'}${periode}`);
});

// Bezoeken per maand, gestapeld klant/prospect. De cijfers komen uit
// handleCachedResults (die telt ze toch al bij het doorlopen van de records),
// dus dit kost geen extra KV-reads en zeker geen AI-aanroep.
const MAAND_NAMEN = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
function renderVisitsChart(perMaand, geschat) {
  const card = document.getElementById('visitsCard');
  const host = document.getElementById('visitsChart');
  if (!card || !host) return;
  const maanden = Object.keys(perMaand || {}).filter(Boolean).sort();
  if (!maanden.length) {
    // Niet stilletjes verdwijnen: bezoeken worden pas geregistreerd vanaf de
    // versie van 14/09, dus bestanden die daarvóór geanalyseerd zijn hebben er
    // nog geen. Eén keer heropladen volstaat en kost geen AI (alle opmerkingen
    // staan al in de cache).
    host.className = 'visits';
    host.innerHTML = '<p class="visits-empty">Geen bezoeken gevonden voor deze selectie.</p>';
    card.hidden = false;
    return;
  }
  const rijen = maanden.map((m) => {
    const v = perMaand[m] || { klant: 0, prospect: 0 };
    return { maand: m, klant: v.klant || 0, prospect: v.prospect || 0, totaal: (v.klant || 0) + (v.prospect || 0) };
  });
  const max = Math.max(...rijen.map((r) => r.totaal), 1);
  const totKlant = rijen.reduce((s, r) => s + r.klant, 0);
  const totProspect = rijen.reduce((s, r) => s + r.prospect, 0);

  const kolommen = rijen
    .map((r) => {
      // Hoogtes als percentage van de hoogste maand; de staaf zelf vult de
      // kolom van onder naar boven.
      const hKlant = (r.klant / max) * 100;
      const hProspect = (r.prospect / max) * 100;
      const titel = `${maandLabel(r.maand)}: ${r.totaal} bezoek(en) — ${r.klant} klant, ${r.prospect} prospect`;
      return `<div class="visits-col" title="${escapeAttr(titel)}">
        <span class="visits-total">${r.totaal}</span>
        <div class="visits-stack">
          ${r.prospect ? `<div class="visits-seg prospect" style="height:${hProspect}%"></div>` : ''}
          ${r.klant ? `<div class="visits-seg klant" style="height:${hKlant}%"></div>` : ''}
        </div>
      </div>`;
    })
    .join('');
  const labels = rijen.map((r) => `<div class="visits-label">${escapeHtml(maandLabel(r.maand))}</div>`).join('');

  host.className = 'visits';
  host.innerHTML = `
    <div class="visits-legend">
      <span><i class="visits-swatch" style="background:var(--klant)"></i>Klant (${totKlant})</span>
      <span><i class="visits-swatch" style="background:var(--prospect)"></i>Prospect (${totProspect})</span>
    </div>
    <div class="visits-plot">${kolommen}</div>
    <div class="visits-labels">${labels}</div>
    ${geschat ? '<p class="visits-empty">Voor bestanden die geanalyseerd zijn vóór de bezoekregistratie bestond, zijn deze aantallen afgeleid uit de gecachete opmerkingen. Bezoeken zonder bruikbare opmerking ontbreken daar, dus die maanden kunnen iets te laag staan; ze worden exact zodra een admin het bestand één keer opnieuw oplaadt.</p>' : ''}`;
  card.hidden = false;
}

function maandLabel(jjjjMm) {
  const [jaar, maand] = (jjjjMm || '').split('-');
  const idx = parseInt(maand, 10) - 1;
  if (!jaar || Number.isNaN(idx) || !MAAND_NAMEN[idx]) return jjjjMm || '';
  return `${MAAND_NAMEN[idx]} ${jaar.slice(2)}`;
}

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

    section.innerHTML = `
      <div class="card">
        <h2 class="part-title">Deel 1 — Bestaande klanten</h2>
        <p class="part-sub">${CATEGORY_LABELS[cat]} · gebaseerd op ${stats.existing.customers.length} rapporten</p>
        <div class="stat-row">
          <div class="stat"><b>${stats.existing.customers.length}</b><span>bestaande klanten met input</span></div>
        </div>
        ${renderCustomerList(stats.existing.customers, 'Bekijk welke klanten', cat, 'existing')}

        <h2 class="part-title" style="margin-top:18px;">Signalen voor R&amp;D &amp; Product Management</h2>
        ${renderTopicDomains(existingAi.topic_tags, cat, 'existing')}
        ${renderWishBlock(existingAi.topic_tags, cat, 'existing')}

      </div>
      <div class="card">
        <h2 class="part-title">Deel 2 — Prospecting</h2>
        <p class="part-sub">${CATEGORY_LABELS[cat]} · gebaseerd op ${stats.prospecting.customers.length} rapporten</p>
        <div class="stat-row">
          <div class="stat"><b>${stats.prospecting.customers.length}</b><span>prospects</span></div>
          <div class="stat"><b>&euro;${Math.round(stats.prospecting.potentialSum).toLocaleString('nl-BE')}</b><span>totaal potentieel (schatting)</span></div>
        </div>
        ${renderCustomerList(stats.prospecting.customers, 'Bekijk welke prospects', cat, 'prospecting')}
        ${renderProspectSignals(stats.prospecting.signals, cat)}

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
// Vaste classificatie per prospect-opmerking (zie prospect_signals in
// worker.js). Komt uit de cache, dus dit blok verschijnt ook bij "Filteren"
// zonder nieuwe AI-aanroep.
const INTEREST_LABELS = { concreet: 'Concrete vraag', orienterend: 'Oriënterend', geen: 'Geen signaal' };
const BARRIER_LABELS = {
  prijs: 'Prijs',
  concurrent: 'Concurrent',
  budget_timing: 'Budget of timing',
  technisch: 'Technisch',
  bestaande_leverancier: 'Bestaande leverancier',
  geen: 'Geen drempel vermeld',
};
function renderProspectSignals(signals, cat) {
  if (!signals || !signals.length) return '';
  const perInteresse = {};
  const perDrempel = new Map();
  for (const s of signals) {
    if (!s) continue;
    const i = s.interest || 'geen';
    perInteresse[i] = (perInteresse[i] || 0) + 1;
    const b = s.barrier || 'geen';
    if (b === 'geen') continue;
    // Detail per klant bijhouden i.p.v. als losse lijst: anders belandde de
    // eerste willekeurige detailzin als een lange pill rechts van de titel,
    // zonder dat je zag bij wie ze hoorde.
    if (!perDrempel.has(b)) perDrempel.set(b, { klanten: new Set(), details: new Map() });
    const bucket = perDrempel.get(b);
    if (s.customer) bucket.klanten.add(s.customer);
    if (s.customer && s.detail) {
      if (!bucket.details.has(s.customer)) bucket.details.set(s.customer, []);
      const lijst = bucket.details.get(s.customer);
      if (!lijst.includes(s.detail)) lijst.push(s.detail);
    }
  }
  const volgorde = ['concreet', 'orienterend', 'geen'];
  const tellers = volgorde
    .filter((k) => perInteresse[k])
    .map((k) => `<div class="stat"><b>${perInteresse[k]}</b><span>${escapeHtml(INTEREST_LABELS[k])}</span></div>`)
    .join('');
  const drempels = [...perDrempel.entries()]
    .sort((a, b) => b[1].klanten.size - a[1].klanten.size)
    .map(([key, v]) => {
      const klantDetails = [...v.klanten].map((naam) => ({ naam, details: v.details.get(naam) || [] }));
      return renderDetailsBlockMetUitleg(
        BARRIER_LABELS[key] || key,
        klantDetails,
        '<span class="pill neutral">drempel</span>',
        cat,
        'prospecting'
      );
    })
    .join('');
  return `
    <h2 class="part-title" style="margin-top:18px;">Interesse per prospect</h2>
    <div class="stat-row">${tellers || '<div class="stat"><b>—</b><span>geen classificatie</span></div>'}</div>
    ${drempels ? `<h2 class="part-title" style="margin-top:18px;">Drempels (per opmerking geclassificeerd)</h2>${drempels}` : ''}`;
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

/* --- Globale barometer (cross-categorie) ---------------------------------
 * Volledig opgebouwd uit de al opgehaalde per-categorie resultaten (agg +
 * aiCategories) — geen enkele AI-aanroep. Alles komt uit de KV, dus dit tab
 * werkt identiek voor een user als voor een admin.
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
  // concurrent-naam -> { klanten, prospects, categorieen }. De splitsing is
  // niet cosmetisch: bij een prospect gaat het gesprek per definitie over wie
  // het vandaag levert, dus daar vallen de meeste merknamen. Ze samen in één
  // teller gooien zou verbergen dat een merk vooral bij nog-niet-klanten leeft.
  const competitorCustomers = new Map();
  const concurrentBucket = (naam) => {
    if (!competitorCustomers.has(naam)) {
      competitorCustomers.set(naam, { klanten: new Set(), prospects: new Set(), categorieen: new Set() });
    }
    return competitorCustomers.get(naam);
  };
  let totalPotential = 0;
  let totalProspects = 0;

  for (const cat of cats) {
    const label = CATEGORY_LABELS[cat];
    const stats = agg[cat];
    const ai = (aiCategories && aiCategories[cat]) || {};
    const existingAi = ai.existing_customers || {};
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
      // Positief en negatief wegen even zwaar bij het bepalen van het oordeel
      // van één klant: we tellen zijn positieve en negatieve opmerkingen en
      // kijken welke kant doorweegt. Evenveel van beide (bv. één lovende en
      // één kritische opmerking) geeft neutraal.
      //
      // Voorheen won het meest kritische signaal altijd: één klacht maakte een
      // verder tevreden klant volledig negatief. Dat drukte de scores
      // structureel naar beneden. De klachten zelf blijven onverminderd
      // zichtbaar bij de werkpunten en de thema's — enkel deze optelling is
      // evenwichtiger geworden.
      let pos = 0;
      let neg = 0;
      let neu = 0;
      for (const s of list) {
        if (s === 'positive') pos++;
        else if (s === 'negative') neg++;
        else if (s === 'neutral') neu++;
      }
      // Enkel "geen mening": deze klant telt nergens mee, ook niet in de noemer.
      if (!pos && !neg && !neu) continue;
      anySet.add(customer);
      if (neg > pos) negSet.add(customer);
      else if (pos > neg) posSet.add(customer);
      // Gelijkspel of enkel neutrale opmerkingen: telt wel in de noemer, maar
      // draagt niets bij aan de teller.
    }

    const sampleSize = anySet.size;
    // Noemer telt UNIEKE klanten, niet opmerkingen. Stond eerder op
    // stats.existing.customers.length — het aantal records — waardoor een klant
    // met drie opmerkingen drie keer meetelde. Teller en noemer zetten nu
    // allebei klanten tegenover klanten ("43 van de 95 klanten").
    const totalCustomers = new Set(stats.existing.customers.map((k) => k.name).filter(Boolean)).size;
    const score = sampleSize ? (posSet.size - negSet.size) / sampleSize : null;

    const prospectKlanten = new Set((stats.prospecting.customers || []).map((k) => k.name).filter(Boolean));
    perCategory.push({
      cat,
      label,
      score,
      sampleSize,
      totalCustomers,
      prospects: prospectKlanten.size,
      prospectNamen: [...prospectKlanten],
      potentialSum: stats.prospecting.potentialSum || 0,
    });

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
        byTopic.set(key, {
          domain: t.domain,
          topic: t.topic,
          posCustomers: new Set(),
          negCustomers: new Set(),
          // Per klant de concrete "detail"-zinnetjes bijhouden. Zonder dit
          // klapte een onderwerp op het globaal tab open naar kale namen,
          // terwijl de categorietabs wél tonen wát die klant zei.
          posDetails: new Map(),
          negDetails: new Map(),
        });
      }
      const b = byTopic.get(key);
      const bewaarDetail = (kaart, klant, detail) => {
        if (!klant || !detail) return;
        if (!kaart.has(klant)) kaart.set(klant, []);
        const lijst = kaart.get(klant);
        if (!lijst.includes(detail)) lijst.push(detail);
      };
      if (t.customer && t.sentiment === 'positive') {
        b.posCustomers.add(t.customer);
        bewaarDetail(b.posDetails, t.customer, t.detail);
      }
      if (t.customer && t.sentiment === 'negative') {
        b.negCustomers.add(t.customer);
        bewaarDetail(b.negDetails, t.customer, t.detail);
      }

      // Concurrenten worden sinds 14/09 bij élk onderwerp vastgelegd, niet enkel
      // bij een prijsvergelijking — en we houden bij in welke productcategorieën
      // ze genoemd worden, zodat zichtbaar is waar iemand wél en niet concurreert.
      if (t.competitor) {
        const comp = t.competitor.trim();
        if (comp) {
          const bucketComp = concurrentBucket(comp);
          if (t.customer) bucketComp.klanten.add(t.customer);
          bucketComp.categorieen.add(label);
        }
      }
    }

    // Zet een klantenverzameling om in [{ naam, details }] — de volgorde van
    // de namen blijft behouden, de details komen uit één of meer kaarten.
    const metDetails = (klanten, ...kaarten) => [...klanten].map((naam) => {
      const details = [];
      for (const kaart of kaarten) {
        for (const d of (kaart.get(naam) || [])) if (!details.includes(d)) details.push(d);
      }
      return { naam, details };
    });

    for (const { domain, topic, posCustomers, negCustomers, posDetails, negDetails } of byTopic.values()) {
      const topicLabel = (TAXONOMY[domain] && TAXONOMY[domain].topics[topic]) || topic;
      if (domain === 'product_techniek' && topic === 'feature_wens') {
        if (posCustomers.size || negCustomers.size) {
          const alle = new Set([...posCustomers, ...negCustomers]);
          allWishes.push({
            cat, label, text: topicLabel, count: alle.size,
            klanten: [...alle],
            klantDetails: metDetails(alle, posDetails, negDetails),
          });
        }
        continue;
      }
      if (!ROADMAP_DOMAINS.includes(domain)) continue;
      if (negCustomers.size) allIssues.push({
        cat, label, text: topicLabel, count: negCustomers.size,
        klanten: [...negCustomers],
        klantDetails: metDetails(negCustomers, negDetails),
      });
      if (posCustomers.size) allPositive.push({
        cat, label, text: topicLabel, count: posCustomers.size,
        klanten: [...posCustomers],
        klantDetails: metDetails(posCustomers, posDetails),
      });
    }

    // Drempels komen nu uit de vaste classificatie per prospect-opmerking (die
    // in de KV zit), niet meer uit een verhalend AI-veld — zo werkt dit blok
    // ook in de weergave uit de cache.
    for (const s of (stats.prospecting.signals || [])) {
      const comp = (s && s.competitor || '').trim();
      if (!comp) continue;
      const bucketComp = concurrentBucket(comp);
      if (s.customer) bucketComp.prospects.add(s.customer);
      bucketComp.categorieen.add(label);
    }

    const drempelKlanten = new Map();
    for (const s of (stats.prospecting.signals || [])) {
      if (!s || !s.barrier || s.barrier === 'geen') continue;
      if (!drempelKlanten.has(s.barrier)) drempelKlanten.set(s.barrier, { klanten: new Set(), details: new Map() });
      const bucket = drempelKlanten.get(s.barrier);
      if (!s.customer) continue;
      bucket.klanten.add(s.customer);
      if (s.detail) {
        if (!bucket.details.has(s.customer)) bucket.details.set(s.customer, []);
        const lijst = bucket.details.get(s.customer);
        if (!lijst.includes(s.detail)) lijst.push(s.detail);
      }
    }
    for (const [key, bucket] of drempelKlanten) {
      allBarriers.push({
        cat, label, text: BARRIER_LABELS[key] || key, count: bucket.klanten.size,
        // Drempels gaan over prospects, niet over bestaande klanten — de
        // klantlink moet dus naar het prospect-deel wijzen.
        part: 'prospecting',
        klanten: [...bucket.klanten],
        klantDetails: metDetails(bucket.klanten, bucket.details),
      });
    }

    totalPotential += stats.prospecting.potentialSum || 0;
    totalProspects += stats.prospecting.customers.length;


  }

  // Een "breed gedragen" signaal is er een dat door minstens MIN_BREED_GEDRAGEN
  // verschillende klanten genoemd wordt. Zonder die ondergrens presenteert de
  // kop "de drie breedst gedragen signalen" een onderwerp dat twee mensen
  // vermeldden als een trend — vooral zichtbaar aan de positieve kant, waar
  // bezoekverslagen van nature weinig vastleggen (vertegenwoordigers noteren
  // problemen en to do's, zelden een compliment).
  const MIN_BREED_GEDRAGEN = 3;
  const breedGedragen = (lijst) => lijst.filter((it) => it.count >= MIN_BREED_GEDRAGEN).slice(0, 3);
  const maxCount = (lijst) => (lijst.length ? lijst[0].count : 0);

  const byCountDesc = (a, b) => b.count - a.count;
  allIssues.sort(byCountDesc);
  allWishes.sort(byCountDesc);
  allPositive.sort(byCountDesc);
  allBarriers.sort(byCountDesc);

  const topCompetitors = [...competitorCustomers.entries()]
    .map(([name, v]) => ({
      name,
      count: v.klanten.size + v.prospects.size,
      klantCount: v.klanten.size,
      prospectCount: v.prospects.size,
      categorieen: [...v.categorieen],
    }))
    .sort(byCountDesc)
    .slice(0, 8);

  // Totaalscore over alle productgroepen: gewogen gemiddelde van de
  // categoriescores, waarbij elke categorie meeweegt naar het aantal klanten
  // met een uitgesproken mening. Een categorie waarover maar twee klanten iets
  // zeiden, trekt de totaalscore dus niet even hard als een categorie met
  // dertig — wat bij een gewoon gemiddelde wél zou gebeuren.
  const metScore = perCategory.filter((c) => c.score !== null && c.sampleSize > 0);
  const totaalSample = metScore.reduce((s, c) => s + c.sampleSize, 0);
  const totaalScore = totaalSample
    ? metScore.reduce((s, c) => s + c.score * c.sampleSize, 0) / totaalSample
    : null;
  const totaalKlanten = new Set(
    cats.flatMap((cat) => (agg[cat].existing.customers || []).map((k) => k.name).filter(Boolean))
  ).size;

  // Per categorie de drie sterkst gedragen thema's — dezelfde rangschikking
  // (aantal unieke klanten) als de lijst over alle categorieën heen.
  const perCategorieTop = (lijst) => {
    const perCat = new Map();
    for (const it of lijst) {
      if (!perCat.has(it.cat)) perCat.set(it.cat, []);
      perCat.get(it.cat).push(it);
    }
    return cats
      .filter((cat) => perCat.has(cat))
      .map((cat) => ({
        cat,
        label: CATEGORY_LABELS[cat],
        items: perCat.get(cat).sort(byCountDesc).slice(0, 3),
      }));
  };

  return {
    perCategory,
    totaalScore,
    totaalSample,
    totaalKlanten,
    topIssues: breedGedragen(allIssues),
    topWishes: breedGedragen(allWishes),
    topPositive: breedGedragen(allPositive),
    maxIssues: maxCount(allIssues),
    maxWishes: maxCount(allWishes),
    maxPositive: maxCount(allPositive),
    minBreedGedragen: MIN_BREED_GEDRAGEN,
    positiefPerCategorie: perCategorieTop(allPositive),
    problemenPerCategorie: perCategorieTop(allIssues),
    wensenPerCategorie: perCategorieTop(allWishes),
    topBarriers: allBarriers.slice(0, 8),
    topCompetitors,
    totalPotential,
    totalProspects,
  };
}

function renderGlobalSection(overview) {
  const scoreRow = (c, extraClass) => {
    if (c.score === null) {
      return `
        <div class="score-row${extraClass ? ' ' + extraClass : ''}">
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
      <div class="score-row${extraClass ? ' ' + extraClass : ''}">
        <span class="score-label">${escapeHtml(c.label)}</span>
        <div class="score-track">
          <div class="score-mid"></div>
          <div class="score-fill ${positive ? 'pos' : 'neg'}" style="${fillStyle}"></div>
        </div>
        <span class="score-value ${positive ? 'pos' : 'neg'}">${positive ? '+' : ''}${Math.round(c.score * 100)}%</span>
        <span class="score-warn"${lowSample ? ' title="Gebaseerd op weinig klantopinies"' : ''}>${c.sampleSize}/${c.totalCustomers}</span>
      </div>`;
  };

  const scoreRows = overview.perCategory.map((c) => scoreRow(c)).join('');
  const totaalRij = scoreRow(
    {
      label: 'Alle productgroepen',
      score: overview.totaalScore,
      sampleSize: overview.totaalSample,
      totalCustomers: overview.totaalKlanten,
    },
    'score-total'
  );

  // Staat er wel materiaal, maar haalt niets de ondergrens, dan is "geen
  // signalen" misleidend: er zijn er wel, ze worden enkel door te weinig
  // klanten gedeeld om van een trend te spreken. Dat zeggen we met zoveel
  // woorden, en verwijzen door naar de lijst per categorie hieronder.
  const dunneLijstTekst = (max, soort) =>
    `Te weinig gedeelde ${soort} om te rangschikken: het breedst genoemde onderwerp komt bij ${max} klant${max === 1 ? '' : 'en'} voor, en we tonen er pas een top drie vanaf ${overview.minBreedGedragen}. Hieronder staan ze wel per productcategorie.`;

  // Ook de cross-categorie top drie is openklapbaar: dezelfde klantenlijst met
  // detailzinnen als de blokken per categorie hieronder. Rijen zonder klanten
  // achter zich (de prospect-drempels) blijven een gewone regel.
  const rankedList = (items, badgeClass, badgeText, emptyText) => {
    if (!items.length) return `<div class="top-block"><p class="narrative">${emptyText}</p></div>`;
    const rijen = items.map((it) => {
      const klantDetails = it.klantDetails
        || (it.klanten || []).map((naam) => ({ naam, details: [] }));
      const badges = `<span class="theme-badges"><span class="pill ${badgeClass}">${badgeText}</span> <span class="count-badge">${it.count}</span></span>`;
      if (!klantDetails.length) {
        return `
      <div class="ranked-row">
        <span class="ranked-cat">${escapeHtml(it.label)}</span>
        <span class="ranked-text">${escapeHtml(it.text)}</span>
        <span class="pill ${badgeClass}">${badgeText}</span>
        <span class="count-badge">${it.count}</span>
      </div>`;
      }
      return `
      <details class="theme-details ranked-details">
        <summary>
          <span class="ranked-cat">${escapeHtml(it.label)}</span>
          <span class="ranked-text">${escapeHtml(it.text)}</span>
          ${badges}
        </summary>
        ${klantLijstHtml(klantDetails, it.cat, it.part || 'existing')}
      </details>`;
    }).join('');
    return `<div class="top-block">${rijen}</div>`;
  };

  // Per categorie de top 3, openklapbaar met per klant het concrete
  // detail-zinnetje — dezelfde opbouw als op de categorietabs. De naam blijft
  // klikbaar en opent het volledige bezoekrapport van die klant.
  const perCategorieBlok = (groepen, badgeClass, badgeText, emptyText) => {
    if (!groepen.length) return `<p class="narrative">${emptyText}</p>`;
    return groepen.map((g) => `
      <h3 class="part-subtitle">${escapeHtml(g.label)}</h3>
      ${g.items.map((it) =>
        renderDetailsBlockMetUitleg(
          it.text,
          it.klantDetails || (it.klanten || []).map((naam) => ({ naam, details: [] })),
          `<span class="pill ${badgeClass}">${badgeText}</span>`,
          g.cat,
          'existing'
        )
      ).join('')}`).join('');
  };

  return `
    <div class="card">
      <h2 class="part-title">Globale barometer</h2>
      <p class="part-sub">Score per productcategorie, berekend op unieke bestaande klanten met een uitgesproken mening. Per klant wegen zijn positieve en negatieve opmerkingen even zwaar: telt de ene kant door, dan is die klant positief of negatief; evenveel van beide maakt hem neutraal. Klanten zonder uitgesproken mening vallen weg; neutrale klanten tellen wel mee in de noemer. Het getal rechts (bv. "43/95") leest als: op 95 klanten met een opmerking in deze categorie hadden er 43 een uitgesproken mening.</p>
      <div class="score-list">${scoreRows}</div>
      <div class="score-list score-total-wrap">${totaalRij}</div>
      <p class="part-sub" style="margin-top:8px;">De totaalscore is een gewogen gemiddelde: elke categorie weegt mee naar het aantal klanten met een uitgesproken mening, zodat een categorie waarover maar enkelen iets zeiden het geheel niet scheeftrekt.</p>
    </div>
    <div class="card">
      <h2 class="part-title">Sterke punten</h2>
      <p class="part-sub">De positieve signalen die door minstens drie verschillende klanten gedeeld worden, daarna per categorie de top drie. Gerangschikt op het aantal unieke klanten dat het onderwerp positief vermeldt. Klik een onderwerp open voor de klanten en hun bezoekrapport.</p>
      ${rankedList(overview.topPositive, 'positive', 'positief', overview.maxPositive ? dunneLijstTekst(overview.maxPositive, 'positieve signalen') : 'Geen uitgesproken positieve signalen.')}
      <h2 class="part-title section-split">Per productcategorie</h2>
      ${perCategorieBlok(overview.positiefPerCategorie, 'positive', 'positief', 'Geen positieve signalen per categorie.')}
    </div>
    <div class="card">
      <h2 class="part-title">Werkpunten</h2>
      <p class="part-sub">Problemen en wensen uit Product &amp; Techniek, Levering &amp; Logistiek en Service &amp; Herstelling. Eerst wat door minstens drie verschillende klanten gedeeld wordt, daarna per categorie de top drie.</p>
      <h3 class="part-subtitle">Grootste problemen</h3>
      ${rankedList(overview.topIssues, 'issue', 'probleem', overview.maxIssues ? dunneLijstTekst(overview.maxIssues, 'problemen') : 'Geen technische/logistieke/service-meldingen gerapporteerd.')}
      <h3 class="part-subtitle">Meest gevraagde wensen</h3>
      ${rankedList(overview.topWishes, 'request', 'wens', overview.maxWishes ? dunneLijstTekst(overview.maxWishes, 'wensen') : 'Geen gewenste features gerapporteerd.')}
      <h2 class="part-title section-split">Problemen per productcategorie</h2>
      ${perCategorieBlok(overview.problemenPerCategorie, 'issue', 'probleem', 'Geen problemen per categorie.')}
      <h2 class="part-title section-split">Wensen per productcategorie</h2>
      ${perCategorieBlok(overview.wensenPerCategorie, 'request', 'wens', 'Geen wensen per categorie.')}
    </div>
    <div class="card">
      <h2 class="part-title">Concurrentiepositie</h2>
      <p class="part-sub">Concurrenten die bij naam genoemd worden, met de productcategorieën waarin dat gebeurt. Het getal rechts is het totaal aantal firma's dat de naam vermeldt, met daarnaast de opsplitsing tussen bestaande klanten en prospects — bij een prospect gaat het gesprek per definitie over wie het vandaag levert, dus daar vallen doorgaans de meeste namen.</p>
      ${overview.topCompetitors && overview.topCompetitors.length
        ? overview.topCompetitors.map((c) => `
          <div class="ranked-row">
            <span class="ranked-text">${escapeHtml(c.name)}</span>
            <span class="ranked-cat">${escapeHtml((c.categorieen || []).join(' · ') || '—')}</span>
            <span class="comp-split">${c.klantCount} klant${c.klantCount === 1 ? '' : 'en'} · ${c.prospectCount} prospect${c.prospectCount === 1 ? '' : 's'}</span>
            <span class="count-badge">${c.count}</span>
          </div>`).join('')
        : '<p class="narrative">Geen concurrenten bij naam vermeld.</p>'}
    </div>
    <div class="card">
      <h2 class="part-title">Prospecting</h2>
      <div class="stat-row">
        <div class="stat"><b>${overview.totalProspects}</b><span>prospects (alle categorieën)</span></div>
        <div class="stat"><b>&euro;${Math.round(overview.totalPotential).toLocaleString('nl-BE')}</b><span>totaal potentieel (schatting)</span></div>
      </div>
      <h2 class="part-title" style="margin-top:16px;">Per productcategorie</h2>
      <p class="part-sub">Dezelfde cijfers als op de categorietabs — ze komen uit dezelfde records. Klik open voor de prospects zelf.</p>
      ${overview.perCategory.filter((c) => c.prospects).length
        ? overview.perCategory.filter((c) => c.prospects).map((c) =>
            renderDetailsBlock(
              c.label,
              c.prospectNamen || [],
              `<span class="pill neutral">&euro;${Math.round(c.potentialSum).toLocaleString('nl-BE')}</span>`,
              c.cat,
              'prospecting'
            )
          ).join('')
        : '<p class="narrative">Geen prospects in deze selectie.</p>'}
      <h2 class="part-title" style="margin-top:16px;">Grootste drempels</h2>
      ${rankedList(overview.topBarriers, 'neutral', 'drempel', 'Geen drempels gerapporteerd.')}
    </div>
  `;
}

// Lichte, aparte AI-aanroep voor de lopende samenvattende tekst bovenaan de
// barometer — krijgt enkel de al samengevatte cijfers/labels (geen ruwe
// remarks), en laadt onafhankelijk van de rest zodat de 7 categorie-tabs
// er niet op moeten wachten.

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

// Zoals renderDetailsBlock, maar met per klant de concrete "detail"-zinnen
// eronder — dezelfde opbouw als renderTopicBlock op de categorietabs. Het
// globaal tab toonde enkel namen, waardoor je wel zag wíé iets zei maar niet
// wát. Valt terug op een kale naam wanneer er voor die klant geen detail is.
function klantLijstHtml(klantDetails, cat, part) {
  const items = (klantDetails || []).map(({ naam, details }) => {
    const detailsHtml = (details && details.length)
      ? `<ul class="topic-detail-list">${details.map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul>`
      : '';
    return `<div>${customerLinkHtml(naam, cat, part)}${detailsHtml}</div>`;
  }).join('');
  return items ? `<div class="customer-list">${items}</div>` : '';
}

function renderDetailsBlockMetUitleg(label, klantDetails, badgeHtml, cat, part) {
  const lijst = klantDetails || [];
  const inner = klantLijstHtml(lijst, cat, part);
  return `
    <details class="theme-details">
      <summary>
        <span class="theme-label">${escapeHtml(label || '')}</span>
        <span class="theme-badges">${badgeHtml} <span class="count-badge">${lijst.length}</span></span>
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

// Eén uitklapbaar blokje per onderwerp: klantnamen (klikbaar, zie
// renderDetailsBlock) plus een paar concrete voorbeeld-citaten (het
// "detail"-veld per tag) — dat laatste is net wat een vaste taxonomie
// zonder kleur zou missen: telbaar ÉN nog steeds herkenbaar per geval.
// Gesegmenteerd staafje i.p.v. één tekstuele pos/neg/neutraal-pill: elk
// individueel opmerking/tag (niet elke klant — één klant kan het onderwerp
// meermaals aankaarten) is één segment, negatief links (rood), positief
// rechts (groen), neutraal ertussen (grijs). Bij een gelijke stand
// negatief/positief (het is dan geen duidelijk signaal de ene of de andere
// kant op) wordt het hele staafje grijs i.p.v. een misleidende 50/50-split.
function renderSentimentBar(entries) {
  const neg = entries.filter((e) => e.sentiment === 'negative').length;
  const pos = entries.filter((e) => e.sentiment === 'positive').length;
  const neu = entries.filter((e) => e.sentiment === 'neutral').length;
  const total = neg + pos + neu;
  if (!total) return '';
  const parts = [];
  if (neg === pos) {
    for (let i = 0; i < total; i++) parts.push('<span class="seg seg-neutral"></span>');
  } else {
    for (let i = 0; i < neg; i++) parts.push('<span class="seg seg-negative"></span>');
    for (let i = 0; i < neu; i++) parts.push('<span class="seg seg-neutral"></span>');
    for (let i = 0; i < pos; i++) parts.push('<span class="seg seg-positive"></span>');
  }
  return `<span class="sentiment-bar" title="${neg} negatief · ${neu} neutraal · ${pos} positief">${parts.join('')}</span>`;
}

// Zelfde visuele stijl/formaat als renderSentimentBar, maar dan blauw en
// zonder sentiment-verdeling — puur het aantal gewenste features/opties
// (zie renderWishBlock/Benchmark product).
function renderWishBar(entries) {
  const total = (entries || []).length;
  if (!total) return '';
  const parts = [];
  for (let i = 0; i < total; i++) parts.push('<span class="seg seg-wish"></span>');
  return `<span class="sentiment-bar wish-bar" title="${total} gewenste feature(s)/optie(s)">${parts.join('')}</span>`;
}

function renderTopicBlock(topicLabel, bucket, cat, part, barType) {
  const names = [...bucket.customers];
  const bar = barType === 'wish' ? renderWishBar(bucket.entries) : renderSentimentBar(bucket.entries);
  // Voorbeeld-teksten ("detail") horen bij één specifieke klant (zelfde
  // topic_tag-entry) — koppel ze daarom aan die klant i.p.v. los boven de
  // klantenlijst te tonen. Alle unieke voorbeelden per klant tonen (geen
  // cap meer) zodat het aantal zichtbare voorbeelden aansluit bij het
  // aantal segmenten in de sentiment-/wish-balk hierboven (die telt elke
  // afzonderlijke tag, niet enkel de unieke tekst).
  const detailsByCustomer = new Map();
  for (const e of bucket.entries) {
    if (!e.customer || !e.detail) continue;
    if (!detailsByCustomer.has(e.customer)) detailsByCustomer.set(e.customer, []);
    const list = detailsByCustomer.get(e.customer);
    if (!list.includes(e.detail)) list.push(e.detail);
  }
  const customerItems = names
    .map((n) => {
      const details = detailsByCustomer.get(n) || [];
      const detailsHtml = details.length
        ? `<ul class="topic-detail-list">${details.map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul>`
        : '';
      return `<div>${customerLinkHtml(n, cat, part)}${detailsHtml}</div>`;
    })
    .join('');
  const inner = customerItems ? `<div class="customer-list">${customerItems}</div>` : '';
  return `
    <details class="theme-details">
      <summary>
        <span class="theme-label">${escapeHtml(topicLabel)}</span>
        <span class="theme-badges">${bar}<span class="count-badge">${names.length}</span></span>
      </summary>
      ${inner}
    </details>
  `;
}

// "Ontbrekende functionaliteit/productwens" is geen sentiment-signaal maar
// een verlanglijst — die hoort niet tussen de pos/neg-onderwerpen in
// Product & Techniek, maar apart onder Benchmark product (zie renderResults).
function renderWishBlock(tags, cat, part) {
  const wishEntries = (tags || []).filter((t) => t && t.domain === 'product_techniek' && t.topic === 'feature_wens');
  if (!wishEntries.length) return '';
  const grouped = groupTopicTags(wishEntries);
  const bucket = grouped.product_techniek && grouped.product_techniek.feature_wens;
  if (!bucket) return '';
  return renderTopicBlock('Gewenste features/opties', bucket, cat, part, 'wish');
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
    const topicKeys = Object.keys(topics)
      .filter((topicKey) => !(domainKey === 'product_techniek' && topicKey === 'feature_wens'))
      .sort((a, b) => topics[b].customers.size - topics[a].customers.size);
    if (!topicKeys.length) continue;
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
