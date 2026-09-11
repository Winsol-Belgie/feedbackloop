/* Winsol Feedbackloop — client-side logic
 * 1) Parse uploaded CRM-export (xlsx/xls/csv, incl. legacy SpreadsheetML .xls)
 * 2) Classify each row into a product category + existing-customer vs prospect
 * 3) Compute exact counts/sums locally (never left to the AI to "guess")
 * 4) Send only the aggregated stats + free-text remarks to /analyze (Cloudflare
 *    Pages Function) which calls Claude for the qualitative synthesis
 * 5) Render the result per the design system tokens in index.html
 *
 * LET OP — categorie-mapping (pas hier aan indien nodig):
 * De CRM-export heeft kolommen Outdoor / Home / Vertical shading / Luifels,
 * maar de gewenste rapport-indeling is Screens / Shutters / Awnings / Pergola.
 * Die twee sets komen niet 1-op-1 overeen (er is bv. geen "Shutters"-kolom).
 * Onderstaande mapping is een eerste, aanpasbare inschatting:
 *   - "Vertical shading" kolom  -> screens
 *   - "Luifels" kolom           -> awnings
 *   - "Outdoor" kolom           -> pergola
 *   - "Home" kolom              -> (niet gemapt op de 4 categorieën)
 * Aangevuld met een keyword-fallback op de vrije tekst (Remark/Re), o.a. om
 * "shutters" te vullen, aangezien daar geen aparte kolom voor bestaat.
 */

const CATEGORY_LABELS = {
  screens: 'Screens',
  shutters: 'Rolluiken (Shutters)',
  awnings: 'Luifels (Awnings)',
  pergola: "Pergola's",
};

const COLUMN_CATEGORY_MAP = {
  'outdoor': 'pergola',
  'vertical shading': 'screens',
  'luifels': 'awnings',
};

const KEYWORD_CATEGORY_MAP = [
  { cat: 'screens', words: ['screen', 'zonnescherm', 'doek'] },
  { cat: 'shutters', words: ['rolluik', 'shutter', 'volet'] },
  { cat: 'awnings', words: ['luifel', 'markies', 'awning'] },
  { cat: 'pergola', words: ['pergola'] },
];

const POTENTIAL_MIDPOINTS = {
  '0-50k': 25000, '50-100k': 75000, '100-150k': 125000,
  '150-500k': 325000, '500k-1m': 750000,
};

let parsedRows = [];

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
      setStatus(`${parsedRows.length} rijen ingelezen uit "${wb.SheetNames[0]}".`);
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

function classifyCategories(row) {
  const cats = new Set();
  for (const col in COLUMN_CATEGORY_MAP) {
    if (row[col] && row[col].trim() !== '') cats.add(COLUMN_CATEGORY_MAP[col]);
  }
  const text = [row['remark'], row['re'], row['reason']].join(' ').toLowerCase();
  for (const { cat, words } of KEYWORD_CATEGORY_MAP) {
    if (words.some((w) => text.includes(w))) cats.add(cat);
  }
  return cats.size ? [...cats] : ['unclassified'];
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
  const cats = ['screens', 'shutters', 'awnings', 'pergola'];
  const agg = {};
  for (const cat of cats) {
    agg[cat] = {
      existing: { n: 0, remarks: [] },
      prospecting: { n: 0, potentialSum: 0, remarks: [] },
    };
  }
  for (const row of rows) {
    const rowCats = classifyCategories(row).filter((c) => cats.includes(c));
    const existing = isExisting(row);
    const remarkText = [row['remark'], row['re']].filter(Boolean).join(' — ');
    for (const cat of rowCats) {
      if (existing) {
        agg[cat].existing.n++;
        if (remarkText) agg[cat].existing.remarks.push(remarkText);
      } else {
        agg[cat].prospecting.n++;
        const potStr = row[Object.keys(COLUMN_CATEGORY_MAP).find((k) => COLUMN_CATEGORY_MAP[k] === cat)] || row['potential'];
        agg[cat].prospecting.potentialSum += parsePotential(potStr);
        if (remarkText) agg[cat].prospecting.remarks.push(remarkText);
      }
    }
  }
  // cap remarks sent to the AI to keep the prompt manageable
  for (const cat of cats) {
    agg[cat].existing.remarks = agg[cat].existing.remarks.slice(0, 150);
    agg[cat].prospecting.remarks = agg[cat].prospecting.remarks.slice(0, 150);
  }
  return agg;
}

document.getElementById('analyzeBtn').addEventListener('click', async () => {
  analyzeBtn.disabled = true;
  setStatus('Data structureren...');
  const agg = buildAggregation(parsedRows);
  setStatus('AI-analyse loopt, dit kan een minuut duren...');
  try {
    const res = await fetch('/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aggregation: agg }),
    });
    if (!res.ok) throw new Error(`Server antwoordde met status ${res.status}`);
    const data = await res.json();
    renderResults(agg, data.categories);
    setStatus(`Analyse voltooid op basis van ${parsedRows.length} rijen.`);
  } catch (err) {
    setStatus('Analyse mislukt: ' + err.message, true);
  } finally {
    analyzeBtn.disabled = false;
  }
});

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
        <p class="part-sub">${CATEGORY_LABELS[cat]} · gebaseerd op ${stats.existing.n} rapporten</p>
        <div class="stat-row">
          <div class="stat"><b>${stats.existing.n}</b><span>bestaande klanten met input</span></div>
        </div>
        <p class="narrative">${escapeHtml(existingAi.general_impression || 'Geen data beschikbaar.')}</p>
        ${renderThemes(existingAi.themes)}
        <h2 class="part-title" style="margin-top:18px;">Benchmark product</h2>
        <p class="narrative">${escapeHtml(existingAi.benchmark_product || '—')}</p>
        <h2 class="part-title" style="margin-top:18px;">Benchmark prijs</h2>
        <p class="narrative">${escapeHtml(existingAi.benchmark_price || '—')}</p>
      </div>
      <div class="card">
        <h2 class="part-title">Deel 2 — Prospecting</h2>
        <p class="part-sub">${CATEGORY_LABELS[cat]} · gebaseerd op ${stats.prospecting.n} rapporten</p>
        <div class="stat-row">
          <div class="stat"><b>${stats.prospecting.n}</b><span>prospects</span></div>
          <div class="stat"><b>&euro;${Math.round(stats.prospecting.potentialSum).toLocaleString('nl-BE')}</b><span>totaal potentieel (schatting)</span></div>
        </div>
        <p class="narrative">${escapeHtml(prospAi.potential_summary || 'Geen data beschikbaar.')}</p>
        <h2 class="part-title" style="margin-top:18px;">Drempels om over te stappen</h2>
        ${renderThemes(prospAi.barriers)}
      </div>
    `;
    sectionsEl.appendChild(section);
  });

  document.getElementById('results').style.display = 'block';
}

function renderThemes(themes) {
  if (!themes || !themes.length) return '<p class="narrative">—</p>';
  return themes.map((t) => `
    <div class="theme">
      <span>${escapeHtml(t.label || t.theme || t.barrier || '')}</span>
      <span><span class="pill ${t.sentiment || 'neutral'}">${t.sentiment || ''}</span> <span class="count-badge">${t.count ?? ''}</span></span>
    </div>
  `).join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}
