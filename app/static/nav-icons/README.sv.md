# Aurora Watch Panel – navigationsikoner

Förslag 1, 2026-11-21. Nio nyritade symboler, anpassade för sajtens mörka gränssnitt.

## Innehåll

- `svg/aurora/`: nio transparenta SVG-ikoner med ljus kontur och cyan accent. Rekommenderad normalvy.
- `svg/mono/`: samma nio symboler i ljust enfärgat utförande, utan de breda tonade fyllningarna.
- `svg/active/`: nio mörka SVG-ikoner för en cyan knappbakgrund. Själva filerna har transparent bakgrund.
- `png-256/`: nio transparenta PNG-exporter, 256 × 256 px, i tvåtonsutförande.
- `aurora-symbols.svg`: nio SVG-symboler för inline-användning med `currentColor` och CSS-variabeln `--aurora-icon-accent`.
- `aurora-icons.css`: färg- och storleksregler för sajtens befintliga `.leftbar-btn`.
- `icon-map.json`: filnamn, svenska och engelska etiketter samt befintliga `data-section`-värden.
- `aurora-icons-aurora-preview.png` och `aurora-icons-mono-preview.png`: förhandsvisningar. Motsvarande SVG-versioner finns också.

## Formgivning

Gemensam `viewBox="0 0 32 32"`, linjetjocklek 1,9 koordinatenheter och rundade linjeändar/hörn. Normal konturfärg är `#DCEAF3`, accentfärg `#38E1FF` och färg för aktiv symbol `#082C37`. Tvåtonsversionens stora fyllningar använder 13 % opacitet. Symbolerna har granskats vid både 24 och 32 CSS-pixlar.

Ingen bakgrund, skugga eller knappform är inbakad i de separata ikonerna. De är avsedda att fungera även utan färgskillnad mellan kontur och accent.

## Koppling till befintliga knappar

| Fil | Funktion | data-section | Symbol-ID |
| --- | --- | --- | --- |
| `01-location.svg` | Plats och översikt | `location` | `aurora-location` |
| `02-cloudmap.svg` | Molnkarta | `cloudmap` | `aurora-cloudmap` |
| `03-light-pollution.svg` | Ljusföroreningar | `lightpollution` | `aurora-light-pollution` |
| `04-sky-direction.svg` | Azimut/riktningar | `objects-in-sky` | `aurora-sky-direction` |
| `05-sky-altitude.svg` | Höjd över tid | `objects-in-sky-graph` | `aurora-sky-altitude` |
| `06-solar-wind.svg` | Solvind | `solarwind` | `aurora-solar-wind` |
| `07-magnetometer.svg` | Magnetometrar | `magnetometer` | `aurora-magnetometer` |
| `08-solar-images.svg` | Solbilder | `solar` | `aurora-solar-images` |
| `09-noaa-forecast.svg` | NOAA-prognoser | `noaa` | `aurora-noaa-forecast` |

Funktionskopplingen bygger på projektets publicerade `app/static/index.html`, `app/static/js/main.js`, `app/static/js/azimuth_map.js` och `app/static/js/skyfield_graph.js` i `slashmad/aurorawatchpanel`. Vilken commit som är driftsatt har inte verifierats.

Källkod: https://github.com/slashmad/aurorawatchpanel

## Rekommenderad integration: inline-symboler

1. Lägg innehållet i `aurora-symbols.svg` en gång i sidans HTML, exempelvis direkt efter öppnande `<body>`.
2. Ladda `aurora-icons.css` efter sajtens ordinarie stilmall.
3. Ersätt bildinnehållet i respektive befintlig knapp med motsvarande SVG-referens. Behåll knappens `data-section`.

```html
<button
  class="leftbar-btn"
  data-section="objects-in-sky-graph"
  title="Altitude over time"
  aria-label="Altitude over time"
>
  <svg class="aurora-nav-icon" viewBox="0 0 32 32"
       aria-hidden="true" focusable="false">
    <use href="#aurora-sky-altitude"></use>
  </svg>
</button>
```

Det befintliga JavaScriptets klass `.active` väljer färger för den aktiva symbolen via den medföljande CSS-filen. Bakgrundsfärgen för den aktiva knappen kommer från sajtens vanliga stilmall.

Inline-symbolerna använder `currentColor` för konturen och `--aurora-icon-accent` för accentdelarna. Variabeln faller tillbaka på `currentColor` om ingen accent är satt. Inga externa skript eller ikonbibliotek behövs.

Den valfria CSS-klassen `aurora-icons-mono` gör inline-symbolerna enfärgade men behåller deras diskreta fyllningar. De separata filerna i `svg/mono/` är en renare linjevariant där de breda fyllningarna har tagits bort.

## Enkel användning som bildfiler

```html
<img src="/static/icons/aurora/01-location.svg"
     width="32" height="32" alt="">
```

De separata filerna innehåller fasta färgvärden och fungerar direkt som `<img>`. Förälderns CSS-`color` färgar inte om en SVG som laddas som separat bild. Använd därför inline-symbolerna för automatisk färgväxling, eller byt bildkälla till motsvarande fil i `svg/active/` när knappen väljs.

## Etiketter

Behåll synliga eller tillgängliga etiketter för funktionerna. Rekommenderade engelska knappnamn är `Location & overview`, `Cloud map`, `Light pollution`, `Sky direction`, `Altitude over time`, `Solar wind`, `Magnetometers`, `Solar imagery` och `NOAA forecasts`.

Prognossymbolen beskriver funktionens innehåll. Den är ingen NOAA-logotyp; NOAA-identiteten anges i knappetiketten och i vyn.

## Granskning

Samtliga 27 separata SVG-filer har samma koordinatsystem och transparent bakgrund. Symbolernas avgränsning, läsbarhet vid 24/32 px samt ljusa och mörka tillstånd har kontrollerats. Förhandsvisningarna visar föreslaget utseende. Ikonerna är ännu inte inlagda eller funktionstestade på den publicerade webbplatsen.
