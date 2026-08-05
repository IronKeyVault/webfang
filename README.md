# Webfang

En lille Chrome/Edge-udvidelse (Windows) der kopierer en artikel fra en webside —
inkl. billeder — til udklipsholderen som **rich HTML**, klar til Ctrl+V i Word,
OneNote eller mail.

## Sådan bruges den

1. Tryk på udvidelsens ikon → **Optag artikel** (eller **▦ Marker område**, se
   nedenfor, hvis du hellere vil trække rammen selv).
2. Peg og klik på artiklen på siden (blå ramme viser hvad der bliver valgt).
3. Juster valget med **⬆ Mere** / **⬇ Mindre** hvis rammen skal dække mere/mindre.
4. Vent til statuslinjen siger **Klar** (den scroller siden igennem og henter
   alle billeder), og tryk **📋 Kopiér**.
5. Indsæt med **Ctrl+V** hvor du vil.

Tryk **Esc** for at fortryde.

## Marker et område selv

Passer indholdet ikke i ét element — fx når videoen står i sin egen kasse over
teksten — så tryk **▦ Marker område** og træk en ramme om det du vil have.

Alt der ligger helt inden for rammen kommer med, uanset hvor i sidens struktur
det står. Et element der kun rager delvist ind, bliver åbnet, så de dele af det
der ER inden for rammen, kommer med. Ligger en del af indholdet i sin egen
iframe — som midterpanelet på en lab-side — kommer den med på samme vilkår: kun
det rammen dækker. Du må gerne scrolle midt i trækket; rammen
holder fast i siden, ikke i skærmen. Resten er som før: statuslinjen siger
**Klar**, og du trykker **📋 Kopiér**.

Trykker du bagefter **⬆ Mere**, **⬇ Mindre** eller **📄 Hele siden**, forlades
rammen, og valget er igen ét element.

## Hent video

1. Tryk på udvidelsens ikon → **🎬 Optag video** (eller Alt+X).
2. Klik på videoen/afspilleren på siden.
3. Er der flere kilder, vælg i dropdown'en — den største/bedste ligger øverst.
4. Tryk **⬇ Hent video**. Filen lander i Overførsler.

Finder den ingenting, så start afspilningen et par sekunder og prøv igen —
streaming-afspillere afslører først deres rigtige URL når de begynder at hente.

### Fortløbende nummer

Filerne får sidens egen titel som navn med et løbenummer foran, fx
`57 - Sådan gør du.mp4`. Nummeret sættes i popup'en under **Næste nr** og
tælles op med 1 for hver hentet video. Det gemmes i browseren, så tælleren
fortsætter hvor den slap næste gang — også efter en genstart. Sæt det til det
tal du er nået til (fx 57), eller slå **Nummerér videoer** fra hvis navnet skal
stå rent. En hentning der fejler bruger ikke et nummer.

### Hvor filerne lander

I browserens downloadmappe — den sættes under `chrome://settings/downloads`, og
en udvidelse må alligevel ikke skrive andre steder hen.

Skal en enkelt video et andet sted hen, så sæt flueben i **Spørg hvor filen skal
gemmes** i popup'en. Så åbner browserens egen gem-dialog, hvor du kan browse frit;
den husker selv sidste placering.

## Når noget ikke kommer med

Tryk **🔎 Diagnose** i popup'en (helst mens et optag står **Klar**). Svaret vises
i popup'en — klik på det for at kopiere det — og fortæller hvor indholdet blev
tabt:

- **hoved-rod** og **valg**: hvad 📄 Hele siden ville tage, og hvad der er valgt nu.
- **tekst-tunge blokke**: sidens paneler, hvor store de er, og om de overhovedet
  ligger inden for valget (`i valget: NEJ` = det er *udvælgelsen* der er problemet).
- **efter oprydning** + **trin der fjerner**: hvor meget tekst hvert oprydningstrin
  i `src/55-clean.js` fjerner fra panelet (`junk-klasser: 8400→120` = det trin
  spiser panelet).

Diagnosen ændrer ikke siden: alt måles på kopier, og tilstanden lægges tilbage.

## Sådan installeres den (uden Web Store)

1. Åbn `chrome://extensions` (eller `edge://extensions`).
2. Slå **Udviklertilstand / Developer mode** til (øverst til højre).
3. Klik **Indlæs pakket / Load unpacked**.
4. Vælg denne mappe (`webfang`).

Udvidelsen dukker nu op i værktøjslinjen.

**Efter en opdatering:** tryk 🔄 på udvidelsens kort under `chrome://extensions`
*og* genindlæs de faner du har stående (F5). Sider der var åbne i forvejen kører
stadig den gamle udgave af udvidelsens script.

## Hvordan det virker

- **Auto-scroll** kører hele siden igennem, så lazy-loadede billeder når at loade.
- **Billeder inlines** som base64 data-URI'er via baggrunds-workeren (som kan
  hente på tværs af oprindelser), så de overlever et paste og ikke bliver til
  døde links. Afviser serveren hentningen, prøves i tur og orden: sidens egen
  fetch (med og uden cookies), billedet malet af skærmen via et canvas, og til
  sidst et skærmklip af billedet som det står i vinduet.
- **Videoafspillere** bliver til ét billede: plakaten hvis afspilleren har en,
  ellers det billede der faktisk står i afspilleren (video-framen læst af et
  canvas, eller et skærmklip hvis videoen er fremmed-origin uden CORS). Før
  forsvandt en afspiller uden `poster` helt — typisk lektionens øverste billede.
  Ligger afspilleren i sin egen container ved siden af teksten (Cisco U.: video
  øverst, artikel nedenunder), bliver den hentet ind øverst i klippet alligevel,
  så man ikke skal ramme begge dele med rammen.
- **Tabeller** bliver til rigtige `<table>`. Mange sider bygger tabeller af
  div'er med CSS-grid eller ARIA-roller, og dem ser Word kun som løs tekst under
  hinanden. De bygges om til en tabel med streger og fed overskriftsrække — også
  rigtige `<table>`, hvis streger ellers ville blive i sidens CSS. Containere med
  afkrydsninger er fredet, så en quiz ikke bliver til en tabel.
- **Afkrydsningsfelter og ikoner** i en quiz kommer ikke med som billeder. Word
  tegner ikke inline-SVG, men reserverer pladsen — hver afkrydsningsboks blev til
  en tom kasse, og ti svar til flere siders luft. Samtidig fjernes sidens egne
  `height`/`padding`-styles fra klippet: de er lavet til en skærm med sidens CSS,
  ikke til et Word-dokument, og var den anden halvdel af luften.
- **Quiz-svar** bliver til punkter, og det valgte svar markeres med ✓ — også når
  afkrydsningen kun findes som DOM-egenskab på siden (`.checked`), hvilket er
  det normale, og ikke som attribut i HTML'en. Er svaret
  et diagram (fx Cisco U.'s "Content Review Question"), følger billedet med
  under teksten — også når svaret kun er et billede.
- **Delte sider** (flere indholdspaneler ved siden af hinanden — fx en lab-side
  med opgaven i venstre panel og scenariet i midten) tages under ét. `<main>`
  dækker tit kun det ene panel, så findes der andre store tekstpaneler uden for
  buddet, flyttes valget op til det fælles ophæng — men kun hvis det ikke slæber
  hele siden med.
- **Paneler med deres egen scroll** tages helt. Deres kasse er kun det synlige,
  mens indholdet inden i er meget højere; rammede frihånds-rammen ikke kassen
  præcist, fik man før kun de linjer der lige stod på skærmen.
- **Indhold i iframes** kommer med. Mange sider – fx Cisco U.'s lab-sider – er
  sat sammen af paneler, hvor midterpanelet er sin egen iframe med sin egen URL
  og sin egen scroll. Udefra er den ét tomt element, så før forsvandt netop den
  midterste del af klippet. Nu kører Webfang i alle rammer: den ydre side sætter
  en pladsholder ind og beder rammen om sit eget færdige klip, som sættes ind i
  stedet. Rammen henter sine egne billeder med sine egne cookies, og spørger på
  samme måde de rammer den selv indeholder. Dækker frihånds-rammen kun en del af
  en iframe, får den kun den del med. Svarer en ramme ikke (fx en PDF-viser,
  hvor udvidelser ikke må køre), springes den over frem for at låse optaget.
- **Rich HTML** lægges på clipboard via Clipboard API (`text/html` + `text/plain`),
  med `document.execCommand('copy')` som fallback.

## Kodens opbygning

Content-scriptet er delt i moduler under `src/`, der indsprøjtes i rækkefølge og
deler ét navnerum (`window.__wf`). Hver fil registrerer sig med
`WF.def(navn, fn)`, så en gen-indsprøjtning på en side der allerede har koden,
lydløst springer over. Fil-listen står **kun** i `manifest.json`; både popup'en
og genvejstasterne læser den derfra med `chrome.runtime.getManifest()`.

| Fil | Ansvar |
| --- | --- |
| `src/00-core.js` | Navnerum, versions-vagt, små hjælpere |
| `src/05-state.js` | Al delt tilstand + løbenummer for en forberedelse |
| `src/10-text.js` | Tekst- og klassemønstre (junk, navigation, styreknapper) |
| `src/20-ui.js` | Ramme, værktøjslinje, knapper, beskeder, status |
| `src/30-page.js` | Scroll, udfoldning af sammenklappet indhold, valg af rod |
| `src/40-media.js` | Afspillere → ét billede (plakat, video-frame, skærmklip) |
| `src/45-tables.js` | Grid/ARIA/div-rækker → rigtige `<table>` |
| `src/50-quiz.js` | Svar-rækker → punkter, markering af det valgte svar |
| `src/55-clean.js` | Oprydningen som en pipeline af navngivne trin |
| `src/60-images.js` | Billed-URL'er + de fire hente-forsøg |
| `src/70-capture.js` | Fra valg til færdigt `ClipboardItem` |
| `src/75-iframes.js` | Indhold i iframes: pladsholder + samtale med rammen |
| `src/80-region.js` | Frihånds-rammen |
| `src/85-video.js` | Video-optag (kilder, valg, hentning) |
| `src/90-app.js` | Knap-handlinger, start/stop, `window.__webfang` |
| `src/95-diagnose.js` | Måler hvorfor et panel ikke kom med (🔎 Diagnose) |

Røgtest (kræver `npm i jsdom`, kører hele optaget i et falsk DOM):

```
node test/smoke.js
```

## Hvordan video-hentning virker

- Afspillerens egen `src` bruges hvis den peger på en rigtig fil (`.mp4`, `.webm`).
- Bruger afspilleren streaming, er `src` en `blob:`-URL der er ubrugelig uden for
  siden. Derfor lytter baggrunds-workeren med på fanens netværkstrafik og noterer
  de playlister/mediefiler den ser (`webRequest` — kun observerende, intet blokeres).
- Ved **HLS** (`.m3u8`) og **DASH** (`.mpd`) hentes alle segmenter og samles til
  én fil i et offscreen-dokument (en service worker har hverken DOM, XML-parser
  eller blob-URL'er).
- fMP4-segmenter er allerede MP4 og lægges bare efter hinanden. **MPEG-TS
  remuxes til MP4** — indholdet pakkes om, så filen spiller alle steder og ikke
  kun i VLC. Går remuxen galt, gemmes en `.ts` i stedet for ingenting.
- Almindelig AES-128-transportkryptering dekrypteres undervejs. **DRM-beskyttet
  indhold (Widevine/FairPlay/SAMPLE-AES) afvises med en klar fejl** — det bryder
  Webfang ikke.
- Har en DASH-stream lyden liggende adskilt fra videoen, bliver det to filer
  (`… (video).mp4` og `… (lyd).m4a`), og statuslinjen siger det. At blande dem
  til én fil kræver en rigtig muxer, og den har Webfang ikke.

## Tredjepartskode

`vendor/mux-mp4.min.js` er [mux.js](https://github.com/videojs/mux.js) 6.3.0 fra
Video.js-projektet, brugt til at remuxe MPEG-TS til MP4. Apache License 2.0 —
licensteksten ligger i `vendor/mux.js-LICENSE.txt`. Resten af Webfang er egen kode.

## Kendte begrænsninger

- CSS-`background-image` kopieres ikke — kun rigtige `<img>`-elementer.
- Inline `<svg>` pakkes om til et billede, fordi Word taber tegningen ved en
  indsætning. Kan den ikke serialiseres, ryger den med som den er.
- Billeder over 12 MB springes over (for at holde clipboard håndterbar).
- Skærmklip-redningen (sidste udvej for billeder) tager højst 8 billeder pr.
  optag. Hvert klip kræver at siden scrolles og fotograferes, og på "Hele siden"
  ville flere dusin gøre optaget minutlangt — og nå at bygge en SPA om under os.
- Udfoldningen af sammenklappet indhold klikker højst 40 steder, af samme grund.
- Et billede der kun kunne reddes med et skærmklip, har skærmens opløsning —
  ikke filens — og er beskåret til det der var synligt i vinduet.
- Virker ikke på `chrome://`-sider eller Web Store-sider (browser-spærret).
- Layout er "godt nok", ikke pixel-perfekt — det er redigerbar tekst + billeder,
  ikke et screenshot.
- Der vælges automatisk den højeste bitrate; man kan ikke vælge kvalitet selv.
- Live-streams understøttes ikke (`type="dynamic"` i DASH afvises).
- Hele videoen holdes i hukommelsen mens den samles, så meget lange film kan
  blive tunge.
