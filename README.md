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
3. Er der flere kilder, vælg i dropdown'en — den længste ligger øverst, og
   spilletiden står på hver linje (`⏱ 3:27:51`).
4. Tryk **⬇ Hent video**. Filen lander i Overførsler.

Finder den ingenting, så start afspilningen et par sekunder og prøv igen —
streaming-afspillere afslører først deres rigtige URL når de begynder at hente.

### Når CDN'en svarer 403

Nogle streaming-tjenester (Hotmart, som bl.a. Teachable-kurser bruger, og
lignende Akamai-signerede opsætninger) udleverer kun videoen til en
forespørgsel der ligner afspillerens egen: rigtig `Origin`, rigtig `Referer`,
sidens cookies. Webfangs eget baggrunds-dokument er sin egen oprindelse og har
ingen af delene — så CDN'en svarede 403, selv om afspilleren i rammen ved siden
af hentede den samme URL uden problemer. `🔎 Kilder` viste `FEJL: HTTP 403` på
hver eneste kilde.

Løsningen er ikke at gætte hvilke headere der mangler, men at flytte selve
hentningen: Webfang beder den **ramme hvor afspilleren bor** om at hente
playlisten og segmenterne. Så er afsenderen siden selv, og browseren sætter
det hele rigtigt uden at vi skal kende opskriften.

Det sker automatisk og kun når det er nødvendigt — den direkte vej prøves
først, og først når den bliver afvist, går Webfang om ad siden. Går ét kald på
en vært den vej, gør resten af segmenterne det samme med det samme, så en lang
video ikke bruger en spildt forespørgsel pr. segment.

To ting det **ikke** kan: DRM-beskyttede streams (dem rører Webfang ikke), og
en video hvis adgangsbillet allerede er udløbet — billetterne i URL'en har et
tidsstempel, og et par af dem lever kun minutter. Hjælper det ikke, så
genindlæs siden (F5), start afspilningen, og prøv igen med det samme.

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
- **Overskrifter sættes et niveau ned.** Sidens titel er et `<h1>`, og det blev
  til Overskrift 1 i Word/OneNote — det niveau hører til dokumentets egen titel,
  ikke til et indklippet afsnit. Derfor bliver `<h1>` til Overskrift 2, og alle
  øvrige overskrifter (`h2`–`h6`) til Overskrift 3, så et klip altid har de
  samme to niveauer uanset hvor dybt siden selv nummererede.
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
- **Kode-blokke beholder deres linjeskift.** Et svar der er en CLI-sekvens er
  fire linjer, ikke én sætning — klemt sammen er det en anden konfiguration end
  den der stod på skærmen. Både `<pre>`/`<code>` og en `<div>` som sidens CSS har
  givet `white-space: pre` genkendes. Har teksten ingen linjeskift i sig — en
  highlighter lægger tit hver linje i sit eget element — hentes linjerne fra
  layoutet: to tekststumper der ikke deler lodret position, står på hver sin
  linje. Kan den levende tvilling ikke findes, læses linjerne af strukturen i
  stedet: `<br>`, blok-elementer og elementer hvis klasse siger "linje"
  (highlight.js lægger hver linje i sin egen `<span class="hljs-input-line">`).
  Tre kilder, fordi ingen af dem holder alene: kildens whitespace findes ikke,
  layoutet kræver at elementet stadig er i siden, og sidens CSS følger ikke med
  i klippet. Linjerne skrives som `<br>`: Word læser gerne vores `font-family`,
  men ignorerer `white-space` — uden `<br>` stod sekvensen på én linje alligevel.
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
  med `document.execCommand('copy')` som fallback. Klippet slutter altid med et
  almindeligt, tomt afsnit: ender det midt i en punktopstilling, står markøren
  efter indsæt stadig i listen, og så bliver alt hvad man skriver eller indsætter
  bagefter også til punkter.

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
| `src/85-video.js` | Video-optag (kilder, rangering, undersøgelse, hentning) |
| `src/90-app.js` | Knap-handlinger, start/stop, `window.__webfang` |
| `src/95-diagnose.js` | Måler hvorfor et panel ikke kom med (🔎 Diagnose) |

Uden for `src/` ligger `mp4-mux.js`, som lægger et videospor og et lydspor
sammen til én MP4 (indlæses i `offscreen.html`).

Røgtest (kræver `npm i jsdom`, kører hele optaget i et falsk DOM):

```
node test/smoke.js
```

Test af sammenlægningen (ingen afhængigheder — bygger små MP4'er med mærkede
chunks og læser den samlede fil på de nye offsets):

```
node test/mux.js
```

## Hvordan video-hentning virker

- Afspillerens egen `src` bruges hvis den peger på en rigtig fil (`.mp4`, `.webm`).
- Bruger afspilleren streaming, er `src` en `blob:`-URL der er ubrugelig uden for
  siden. Derfor lytter baggrunds-workeren med på fanens netværkstrafik og noterer
  de playlister/mediefiler den ser (`webRequest` — kun observerende, intet blokeres).
- **Kom Webfang for sent til**, er playlisten væk fra listen: den hentes én
  gang når afspilleren starter, og bagefter kun segmenter (som sorteres fra).
  Det sker når udvidelsen er genindlæst, service workeren har tabt listen,
  eller siden har skiftet URL undervejs (det rydder listen). Er der så kun
  segmenter eller ingenting, læses hver rammes egen `performance`-log
  (Resource Timing), som stadig husker playlisten — også inde i afspillerens
  iframe, og med rammens id, så 403-omvejen virker som før.
- **Kilderne rangeres, ikke bare måles på størrelsen.** En side med et galleri
  af videoer henter forhåndsvisninger for hvert miniaturebillede, og en stream
  henter sine stumper som `.mp4`-filer — så listen kan sagtens rumme 30+ URL'er.
  Størrelsen udpeger den forkerte: en playliste på 3½ time fylder få kilobyte,
  mens ét segment fylder megabyte. Derfor kommer playlister først, hele filer
  dernæst, og stumper (`seg-12-v1-a1.mp4`, `chunk-…`, `00012.mp4`, alt med
  `range/` i stien eller `?range=a-b`) sidst.
- **Vimeo** (fx kbits.live) bruger hverken `.m3u8` eller `.mpd`, men en signeret
  JSON-playliste. Hvert spor er én mp4-fil skåret i byte-intervaller, og hvert
  interval har sin egen signatur i stien (`range/prot/<base64>/…&pathsig=…`) —
  så URL'en til hele filen findes ikke, og man kan ikke selv regne den ud.
  Playlisten er det eneste sted alle intervallerne står samlet; derfor opsnappes
  den (`/v2/playlist/…`, `playlist.json`, `master.json`) og bruges som kilde.
  Uden den så Webfang kun de få hundrede kilobyte afspilleren lige havde hentet.
- **Playlisternes spilletid måles.** Så snart en kilde er valgt, åbnes de
  playlister der blev fundet, og deres `#EXTINF`/`mediaPresentationDuration`
  lægges sammen. Listen sorterer sig selv om med den længste øverst — det er
  filmen — og spilletiden står på hver linje. Det sker i baggrunden, så
  ⬇ Hent video kan bruges med det samme.
- **🔎 Kilder** undersøger alle kilder og kopierer en rapport: længde,
  antal kvaliteter, segmenter, AES/DRM, live-flag, størrelse og hele URL'en for
  hver. Det er den knap man trykker på, når den hentede fil ikke er hele videoen.
- Ved **HLS** (`.m3u8`) og **DASH** (`.mpd`) hentes alle segmenter og samles til
  én fil i et offscreen-dokument (en service worker har hverken DOM, XML-parser
  eller blob-URL'er).
- fMP4-segmenter er allerede MP4 og lægges bare efter hinanden. **MPEG-TS
  remuxes til MP4** — indholdet pakkes om, så filen spiller alle steder og ikke
  kun i VLC. Går remuxen galt, gemmes en `.ts` i stedet for ingenting.
- Almindelig AES-128-transportkryptering dekrypteres undervejs. **DRM-beskyttet
  indhold (Widevine/FairPlay/SAMPLE-AES) afvises med en klar fejl** — det bryder
  Webfang ikke.
- **Ligger lyden adskilt fra videoen** — som den gør hos både DASH og Vimeo —
  lægges de to spor sammen til én `.mp4` til sidst. Det er ren ompakning:
  billed- og lyddata røres ikke, kun containeren bygges om, så der hverken
  genkodes eller tabes kvalitet. Der er to slags MP4, og de skal samles på hver
  sin måde:
  - **Fragmenteret** (`moof`+`mdat` i tusindvis — det Vimeo leverer): hvert
    fragment beskriver sine samples relativt til sig selv (`tfhd`-flaget
    default-base-is-moof), så de kan flyttes frit. Begge spors `traf` lægges i
    **én** `moof` pr. tidsinterval med ét fælles `mdat` bagefter, og hver
    `traf`s `data_offset` regnes om til sin plads i det. Ét spor pr. `moof` er
    lige så lovligt og lettere at skrive — men VLC afspiller ikke lyden af
    sådan en fil: den viser sporet i menuen og tier. Chrome klarer den fint,
    hvilket gør fejlen let at overse. Desuden får lyden nyt spor-nummer i
    hvert eneste fragment, og `mvex` en `trex` pr. spor.
  - **Progressiv** (ét `moov` med fulde sample-tabeller): her er `stco`/`co64`
    absolutte filpositioner, og når mediedata flyttes bag et nyt, større `moov`,
    peger hver eneste af dem forkert. Filen ville se hel ud, have alle sine
    bytes, og alligevel være ubrugelig.

  Går sammenlægningen galt, får du de to spilbare filer i stedet plus grunden i
  statuslinjen — to filer er bedre end ingen.

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
- Hastigheden er ikke til at skrue meget på. Hvert segment er sin egen
  HTTP-forespørgsel, og `CONCURRENCY` i `offscreen.js` (8) bestemmer hvor mange
  der er i luften ad gangen. Resten sætter CDN'en, din linje og rundturstiden
  pr. forespørgsel — og ved små segmenter er det ventetiden på svar, ikke
  båndbredden, der koster. Statuslinjen viser MB/s og resttid, så man kan se
  om en ændring hjælper. Sætter man tallet for højt, begynder serveren at
  afvise (429), og flere segmenter ligger i hukommelsen samtidig.
