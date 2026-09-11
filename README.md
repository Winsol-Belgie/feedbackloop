# Winsol Feedbackloop

Online tool: upload de periodieke CRM-export (Excel) van bezoekrapporten en
krijg een AI-analyse per productcategorie (Screens, Rolluiken, Luifels,
Pergola's), opgedeeld in **bestaande klanten** en **prospecting** — zoals
beschreven in `Feedbackloop.docx`.

## Hoe het werkt

- `index.html` + `app.js`: pure statische frontend. Leest de Excel client-side
  in (SheetJS), telt/berekent de harde cijfers (aantallen, potentieel in €)
  lokaal in de browser — dat gaat dus nooit "gokken".
- `functions/analyze.js`: een Cloudflare Pages Function (serverless). Krijgt
  enkel de samengevatte cijfers + de losse tekstopmerkingen binnen, en vraagt
  Claude om daar een inhoudelijke synthese van te maken (thema's, sentiment,
  drempels). De Anthropic API-sleutel staat **alleen** op de server, nooit in
  de browser.

## Belangrijke aanname — categorie-mapping

De CRM-export heeft kolommen `Outdoor / Home / Vertical shading / Luifels`,
maar het gewenste rapport is ingedeeld in `Screens / Shutters / Awnings /
Pergola`. Die twee komen niet exact overeen (er is bv. geen aparte
"Shutters"-kolom). De huidige, aanpasbare inschatting staat bovenaan
`app.js` (`COLUMN_CATEGORY_MAP` / `KEYWORD_CATEGORY_MAP`):

- Vertical shading → Screens
- Luifels → Awnings
- Outdoor → Pergola
- Home → (niet gemapt)
- "Shutters" wordt enkel gevuld via trefwoorden in de opmerkingen
  (rolluik/shutter/volet), want er is geen brondata-kolom voor.

**Controleer deze mapping** en pas ze aan in `app.js` indien nodig — dat is
een aanpassing van enkele minuten.

Bestaande klant vs. prospect wordt bepaald via de kolom `Status` (`Active
Customer` = bestaand; `To be contacted` / `Not to be contacted again` =
prospect), met de kolom `Reason` als fallback.

## Deployen — handmatig via Wrangler

Geen Git-koppeling nodig; deploy gebeurt manueel vanaf je eigen machine met
de Cloudflare CLI (zoals bij je andere projecten).

> **Let op — Pages, niet Workers:** deze tool is een *Cloudflare Pages*-project
> (statische site + Pages Functions), geen los Worker-script. Gebruik dus
> steeds `wrangler pages deploy .` / `wrangler pages ...`, nooit het kale
> `wrangler deploy` — dat is een ander Cloudflare-product en maakt een lege
> "Hello World"-Worker aan in plaats van deze tool te deployen.

Eenmalig:

```bash
cd app
npm install
# Login enkel nodig als je nog GEEN CLOUDFLARE_API_TOKEN in je omgeving hebt
# staan. Heb je die al (zoals bij je andere projecten), sla deze stap over —
# wrangler gebruikt die token automatisch en `wrangler login` zal net weigeren.
npx wrangler login

# Pages-project + secret aanmaken (eenmalig)
npx wrangler pages project create feedbackloop
npx wrangler pages secret put ANTHROPIC_API_KEY --project-name=feedbackloop
# → plak hier je sleutel van console.anthropic.com/settings/keys
```

Bij elke nieuwe versie:

```bash
cd app
npx wrangler pages deploy .
# of: npm run deploy
```

Wrangler geeft dan een werkende `*.pages.dev`-URL (niet `*.workers.dev` — dat
laatste wijst op een per-ongeluk aangemaakte Worker, zie hierboven). Een
eigen domein koppelen kan later via het Cloudflare-dashboard (Workers & Pages
→ feedbackloop → Custom domains) — dat vereist geen Git-koppeling en dus ook
geen org-owner-rechten.

`wrangler.toml` staat al klaar met `pages_build_output_dir = "."`, dus de
commando's hierboven werken zonder extra argumenten. Optioneel: zet
`CLAUDE_MODEL` als extra secret/var als je een ander model wil gebruiken dan
de default in `functions/analyze.js`.

### Een Anthropic API-sleutel aanmaken

1. Ga naar console.anthropic.com en log in (of maak een account/organisatie
   aan voor Winsol).
2. **Settings → API keys → Create key**.
3. Zorg voor voldoende krediet/budget op de organisatie (Billing).
4. Kopieer de sleutel meteen (die is nadien niet meer zichtbaar) en gebruik
   ze bij `wrangler pages secret put` hierboven.

## Lokaal testen

```bash
cd app
npm install
npx wrangler pages dev .
```

Dit start de volledige tool lokaal, inclusief de `/analyze`-function (zet
`ANTHROPIC_API_KEY` dan even in een lokaal `.env`-bestand, of geef ze mee als
`--binding ANTHROPIC_API_KEY=sk-...`).
