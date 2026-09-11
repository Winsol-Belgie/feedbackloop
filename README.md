# Winsol Feedbackloop

Online tool: upload de periodieke CRM-export (Excel) van bezoekrapporten en
krijg een AI-analyse per productcategorie (Screens, Shutters, Awnings,
Pergola, Home), opgedeeld in **bestaande klanten** en **prospecting** —
zoals
beschreven in `Feedbackloop.docx`.

## Architectuur

Zelfde patroon als de andere tools: **frontend op GitHub Pages, enkel de
API als Worker op Cloudflare.**

- `index.html` + `app.js`: statische frontend, gehost via GitHub Pages.
  Leest de Excel client-side in (SheetJS), telt/berekent de harde cijfers
  (aantallen, potentieel in €) lokaal in de browser — dat gaat dus nooit
  "gokken".
- `worker.js`: een losstaande Cloudflare Worker. Krijgt enkel de
  samengevatte cijfers + de losse tekstopmerkingen binnen, en vraagt Claude
  om daar een inhoudelijke synthese van te maken (thema's, sentiment,
  drempels). De Anthropic API-sleutel staat **alleen** hier (Worker
  secret), nooit in de frontend-code. De frontend roept deze Worker
  cross-origin aan (CORS zit al in `worker.js`).

## Categorieën

De 5 tabbladen zijn Screens, Shutters (Rolluiken), Awnings (Luifels),
Pergola's en Home (Schrijnwerk, incl. Iqon). De CRM-kolommen "Vertical
shading", "Luifels" en "Home" geven een hint als ze ingevuld zijn, maar zijn
in de praktijk vaak leeg — daarom wordt voor élke rij ook de vrije tekst
(kolom `Remark`, plus `Re`/`Reason`) doorzocht op trefwoorden (`KEYWORDS`
bovenaan `app.js`). Dat is de enige bron voor Pergola en Home (geen
brondata-kolom die betrouwbaar gevuld is) en de fallback voor de andere
drie. Pas de trefwoordenlijsten gerust aan als je merkt dat iets verkeerd of
niet ingedeeld wordt — voor Home staat er nu enkel `schrijnwerk` en `iqon`
in, vul aan met andere termen die jullie gebruiken (ramen, deuren,
kozijnen, ...).

Bestaande klant vs. prospect wordt bepaald via de kolom `Status` (`Active
Customer` = bestaand; `To be contacted` / `Not to be contacted again` =
prospect), met de kolom `Reason` als fallback.

Elk cijfer in de tool (aantallen, potentieel, en de teller naast elk thema)
is uitklapbaar tot de onderliggende klantnamen — er wordt dus nergens een
aantal getoond zonder dat je kan zien over wie het gaat. Claude krijgt de
klantnaam mee bij elke opmerking en moet in zijn thema's/drempels exact die
namen citeren, in plaats van enkel een los cijfer te verzinnen.

Er zit geen limiet op het aantal rijen dat de tool inleest/telt — als je
Excel 500 (of 5000) rijen heeft, tellen ze allemaal mee voor de cijfers. Wel
wordt het aantal *opmerkingen dat naar de AI gestuurd wordt* per
categorie/deel begrensd op `MAX_REMARKS_TO_AI` (standaard 300) om de
promptgrootte/kost te beperken — in de praktijk raak je dat bij een normale
periodieke export niet snel aan.

## Opzetten (eenmalig)

### 1. Frontend — GitHub Pages

Repo → **Settings → Pages** → Source: "Deploy from a branch" → Branch:
`main`, map `/ (root)` → Save. Dit vereist enkel schrijftoegang op de repo
zelf, geen org-owner-rechten (in tegenstelling tot de Cloudflare-GitHub-app
die we eerder probeerden). Na een paar minuten is de tool bereikbaar op
`https://winsol-belgie.github.io/feedbackloop/`.

### 2. API — Cloudflare Worker

```bash
cd app
npm install
# Login enkel nodig als je nog GEEN CLOUDFLARE_API_TOKEN in je omgeving hebt
# staan. Heb je die al (zoals bij je andere projecten), sla deze stap over.
npx wrangler login

npx wrangler deploy
# → toont de *.workers.dev-URL (naam komt uit "name" in wrangler.toml)

npx wrangler secret put ANTHROPIC_API_KEY
# → plak hier je sleutel van console.anthropic.com/settings/keys
```

### 3. Frontend koppelen aan de Worker

Zet de URL uit stap 2 in `app.js`, bovenaan, in `ANALYZE_URL`. Commit en
push — GitHub Pages update automatisch.

```bash
git add app.js
git commit -m "Koppel frontend aan Worker-URL"
git push
```

### Een Anthropic API-sleutel aanmaken

1. Ga naar console.anthropic.com en log in (of maak een account/organisatie
   aan voor Winsol).
2. **Settings → API keys → Create key**.
3. Zorg voor voldoende krediet/budget op de organisatie (Billing).
4. Kopieer de sleutel meteen (die is nadien niet meer zichtbaar) en gebruik
   ze bij `wrangler secret put` hierboven.

## Bij een nieuwe versie

- Enkel frontend gewijzigd (`index.html`/`app.js`): gewoon `git push` —
  GitHub Pages update vanzelf.
- `worker.js` gewijzigd: `npx wrangler deploy` opnieuw draaien.

## Lokaal testen

```bash
cd app
npm install
npx wrangler dev
```

Dit start de Worker lokaal (zet `ANTHROPIC_API_KEY` dan in een lokaal
`.dev.vars`-bestand). Zet tijdelijk `ANALYZE_URL` in `app.js` op
`http://localhost:8787` en open `index.html` rechtstreeks in de browser om
de frontend te testen.
