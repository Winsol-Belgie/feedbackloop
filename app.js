/* Winsol Feedbackloop — client-side logic
 * 1) Parse uploaded CRM-export (xlsx/xls/csv, incl. legacy SpreadsheetML .xls)
 * 2) Classify each row into Screens / Shutters / Awnings / Pergola +
 *    bestaande klant vs. prospect
 * 3) Reken de harde cijfers lokaal uit (aantallen, potentieel in €, wie de
 *    klanten zijn) — dat gaat dus nooit "gokken"
 * 4) Stuur enkel de samengevatte cijfers + klantnamen + opmerkingen naar de
 *    Worker (worker.js), die Claude vraagt om de kwalitatieve synthese
 * 5) Render het resultaat, met per thema/drempel uitklapbaar wélke klanten
 *    erachter zitten
 *
 * Categorisering: de CRM-kolommen "Vertical shading" en "Luifels" geven een
 * hint (indien ingevuld), maar zijn in de praktijk vaak leeg. Daarom wordt
 * voor élke rij ook de vrije tekst (Remark, kolom M — plus Re/Reason)
 * doorzocht op trefwoorden (KEYWORDS hieronder) om af te leiden over welk
 * product het gaat — dat is de enige bron voor Pergola, en de fallback voor
 * de andere drie. Pas de trefwoordenlijsten hier gerust aan.
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
  ],
  pergola: [
    "SO!", 'L!V', 'Origin', "Orig!n", 'Z!P', 'Z!P Cube',
    'lamellendak', 'lamel', 'pergola', "pergola's",
  ],
  outdoor: [
    'Verandasol', 'Wincube', 'Alubox',
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

// URL van de losstaande Cloudflare Worker (zie worker.js).
const ANALYZE_URL = 'https://feedbackloop.gwenn-vanthournout.workers.dev/';

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const fname = document.getElementById('fname');
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
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      parsedRows = normalizeRows(rows);
      setStatus(`${parsedRows.length} rijen ingelezen uit "${wb.SheetNames[0]}". (Alle rijen tellen mee voor de cijfers; er is geen limiet in de tool zelf.)`);
      analyzeBtn.disabled = parsedRows.length === 0;
    } catch (err) {
      setStatus('Kon het bestand niet lezen: ' + err.message, true);
      analyzeBtn.disabled = true;
    }
  };
  reader.readAsArrayBuffer(file);
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
  for (const cat of Object.keys(KEYWORDS)) {
    if (KEYWORDS[cat].some((w) => matchesKeyword(text, w))) cats.add(cat);
  }

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
    for (const cat of rowCats) {
      if (existing) {
        agg[cat].existing.customers.push({ name, remark });
      } else {
        agg[cat].prospecting.customers.push({ name, remark });
        agg[cat].prospecting.potentialSum += potentialForCategory(row, cat);
      }
    }
  }
  return agg;
}

// Beperkte remarks-lijst (met klantnaam) om naar de AI te sturen — enkel
// klanten die ook effectief iets geschreven hebben.
function remarksForAi(customers) {
  return customers.filter((c) => c.remark).slice(0, MAX_REMARKS_TO_AI);
}

document.getElementById('analyzeBtn').addEventListener('click', async () => {
  analyzeBtn.disabled = true;
  setStatus('Data structureren...');
  const agg = buildAggregation(parsedRows);
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
          category: cat,
          existing: { remarks: remarksForAi(v.existing.customers) },
          prospecting: { remarks: remarksForAi(v.prospecting.customers), potentialSum: v.prospecting.potentialSum },
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
  if (failed.length) {
    setStatus(`Analyse deels mislukt voor: ${failed.join(', ')}. De andere categorieën zijn wel bijgewerkt.`, true);
  } else {
    setStatus(`Analyse voltooid op basis van ${parsedRows.length} rijen.`);
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
        ${renderCustomerList(stats.existing.customers, 'Bekijk welke klanten')}
        <p class="narrative">${escapeHtml(existingAi.general_impression || 'Geen data beschikbaar.')}</p>
        ${renderThemes(existingAi.themes)}
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
        ${renderCustomerList(stats.prospecting.customers, 'Bekijk welke prospects')}
        <p class="narrative">${escapeHtml(prospAi.potential_summary || 'Geen data beschikbaar.')}</p>
        <h2 class="part-title" style="margin-top:18px;">Drempels om over te stappen</h2>
        ${renderThemes(prospAi.barriers)}
      </div>
    `;
    sectionsEl.appendChild(section);
  });

  document.getElementById('results').style.display = 'block';
}

function renderCustomerList(customers, label) {
  if (!customers.length) return '';
  const items = customers.map((c) => `<li><strong>${escapeHtml(c.name)}</strong>${c.remark ? ' — ' + escapeHtml(truncate(c.remark, 90)) : ''}</li>`).join('');
  return `<details class="customers-list"><summary>${label} (${customers.length})</summary><ul class="customer-names">${items}</ul></details>`;
}

function renderThemes(themes) {
  if (!themes || !themes.length) return '<p class="narrative">—</p>';
  return themes.map((t) => {
    const names = t.customers || [];
    const label = t.label || '';
    const sentiment = t.sentiment || 'neutral';
    const inner = names.length
      ? `<div class="customer-list">${names.map((n) => `<div>${escapeHtml(n)}</div>`).join('')}</div>`
      : '';
    return `
      <details class="theme-details">
        <summary>
          <span>${escapeHtml(label)}</span>
          <span><span class="pill ${sentiment}">${sentiment}</span> <span class="count-badge">${names.length}</span></span>
        </summary>
        ${inner}
      </details>
    `;
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
