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

## Deployen (eenmalig, ±10 min)

1. Push deze repo naar GitHub (zie hoofdmap-instructies).
2. Ga naar [Cloudflare dashboard](https://dash.cloudflare.com) → **Workers &
   Pages** → **Create application** → **Pages** → **Connect to Git** → kies
   `Winsol-Belgie/feedbackloop`.
3. Build settings: **geen build command nodig**, laat "Build output
   directory" op `app` staan (of verplaats deze map naar de repo-root — zie
   hieronder). Framework preset: "None".
4. Ga naar **Settings → Environment variables** van het Pages-project en
   voeg toe:
   - `ANTHROPIC_API_KEY` — jouw sleutel van
     [console.anthropic.com](https://console.anthropic.com/settings/keys)
     (Encrypt aanvinken).
   - optioneel `CLAUDE_MODEL` als je een ander model wil gebruiken dan de
     default.
5. Deploy. Cloudflare geeft je een `*.pages.dev`-URL — die is meteen de
   werkende tool. Een eigen domein koppelen kan later via dezelfde
   instellingen.

### Een Anthropic API-sleutel aanmaken

1. Ga naar console.anthropic.com en log in (of maak een account/organisatie
   aan voor Winsol).
2. **Settings → API keys → Create key**.
3. Zorg voor voldoende krediet/budget op de organisatie (Billing).
4. Kopieer de sleutel meteen (die is nadien niet meer zichtbaar) en zet ze
   als `ANTHROPIC_API_KEY` in Cloudflare Pages zoals hierboven.

## Lokaal testen

Deze tool heeft geen build-stap. Voor de frontend volstaat een simpele
webserver:

```bash
npx serve app
```

De `/analyze`-function heeft wel Cloudflare's runtime nodig om te draaien:

```bash
npx wrangler pages dev app
```

(zet dan `ANTHROPIC_API_KEY` in een lokaal `.env`-bestand of via
`wrangler pages dev app --binding ANTHROPIC_API_KEY=sk-...`).
