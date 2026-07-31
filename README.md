# Webfang

En lille Chrome/Edge-udvidelse (Windows) der kopierer en artikel fra en webside —
inkl. billeder — til udklipsholderen som **rich HTML**, klar til Ctrl+V i Word,
OneNote eller mail.

## Sådan bruges den

1. Tryk på udvidelsens ikon → **Optag artikel**.
2. Peg og klik på artiklen på siden (blå ramme viser hvad der bliver valgt).
3. Juster valget med **⬆ Mere** / **⬇ Mindre** hvis rammen skal dække mere/mindre.
4. Vent til statuslinjen siger **Klar** (den scroller siden igennem og henter
   alle billeder), og tryk **📋 Kopiér**.
5. Indsæt med **Ctrl+V** hvor du vil.

Tryk **Esc** for at fortryde.

## Hent video

1. Tryk på udvidelsens ikon → **🎬 Optag video** (eller Alt+X).
2. Klik på videoen/afspilleren på siden.
3. Er der flere kilder, vælg i dropdown'en — den største/bedste ligger øverst.
4. Tryk **⬇ Hent video**. Filen lander i Overførsler.

Finder den ingenting, så start afspilningen et par sekunder og prøv igen —
streaming-afspillere afslører først deres rigtige URL når de begynder at hente.

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
  døde links.
- **Rich HTML** lægges på clipboard via Clipboard API (`text/html` + `text/plain`),
  med `document.execCommand('copy')` som fallback.

## Hvordan video-hentning virker

- Afspillerens egen `src` bruges hvis den peger på en rigtig fil (`.mp4`, `.webm`).
- Bruger afspilleren streaming, er `src` en `blob:`-URL der er ubrugelig uden for
  siden. Derfor lytter baggrunds-workeren med på fanens netværkstrafik og noterer
  de playlister/mediefiler den ser (`webRequest` — kun observerende, intet blokeres).
- Ved HLS (`.m3u8`) hentes alle segmenter og samles til én fil i et
  offscreen-dokument (en service worker har hverken DOM eller blob-URL'er).
  fMP4-segmenter giver en `.mp4`; MPEG-TS-segmenter giver en `.ts` (spiller i VLC).
- Almindelig AES-128-transportkryptering dekrypteres undervejs. **DRM-beskyttet
  indhold (Widevine/FairPlay/SAMPLE-AES) afvises med en klar fejl** — det bryder
  Webfang ikke.

## Kendte begrænsninger (v1)

- CSS-`background-image` kopieres ikke — kun rigtige `<img>`-elementer.
- Billeder over 12 MB springes over (for at holde clipboard håndterbar).
- Virker ikke på `chrome://`-sider eller Web Store-sider (browser-spærret).
- Layout er "godt nok", ikke pixel-perfekt — det er redigerbar tekst + billeder,
  ikke et screenshot.
- DASH-streams (`.mpd`) understøttes ikke — kun direkte filer og HLS.
- Ved HLS vælges automatisk den højeste bitrate; man kan ikke vælge kvalitet.
- Live-streams hentes som de ser ud i playlisten lige nu (ingen "optag videre").
