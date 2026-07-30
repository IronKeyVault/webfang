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

## Sådan installeres den (uden Web Store)

1. Åbn `chrome://extensions` (eller `edge://extensions`).
2. Slå **Udviklertilstand / Developer mode** til (øverst til højre).
3. Klik **Indlæs pakket / Load unpacked**.
4. Vælg denne mappe (`webfang`).

Udvidelsen dukker nu op i værktøjslinjen.

## Hvordan det virker

- **Auto-scroll** kører hele siden igennem, så lazy-loadede billeder når at loade.
- **Billeder inlines** som base64 data-URI'er via baggrunds-workeren (som kan
  hente på tværs af oprindelser), så de overlever et paste og ikke bliver til
  døde links.
- **Rich HTML** lægges på clipboard via Clipboard API (`text/html` + `text/plain`),
  med `document.execCommand('copy')` som fallback.

## Kendte begrænsninger (v1)

- CSS-`background-image` kopieres ikke — kun rigtige `<img>`-elementer.
- Billeder over 12 MB springes over (for at holde clipboard håndterbar).
- Virker ikke på `chrome://`-sider eller Web Store-sider (browser-spærret).
- Layout er "godt nok", ikke pixel-perfekt — det er redigerbar tekst + billeder,
  ikke et screenshot.
