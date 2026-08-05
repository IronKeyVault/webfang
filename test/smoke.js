// Røgtest: kør alle content-moduler i jsdom og lav et optag fra ende til anden.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const files = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'))
  .content_scripts[0].js;

const html = `<!doctype html><html><body>
<nav class="site-nav"><a href="/x">Menu</a></nav>
<main>
  <h1>Overskrift</h1>
  <p>Første afsnit med noget tekst der er lang nok til at tælle med i optaget.</p>
  <a href="/tilbage">Return to Course</a>
  <img src="/billede.png" alt="et billede">
  <p><a href="https://eksempel.dk/side">Et rigtigt link</a> midt i teksten.</p>
  <table><tr><td>A</td><td>B</td></tr></table>
  <form>
    <ul>
      <li><input type="radio" id="a1" checked><label for="a1">Svar et</label></li>
      <li><input type="radio" id="a2"><label for="a2">Svar to</label></li>
    </ul>
    <button>Submit</button>
  </form>
  <div role="table">
    <div role="row"><div role="columnheader">K1</div><div role="columnheader">K2</div></div>
    <div role="row"><div role="cell">v1</div><div role="cell">v2</div></div>
  </div>
  <details><summary>Vis mere</summary><p>Skjult tekst der skal med.</p></details>
  <div class="quiz2">
    <div class="answer" style="height:72px;padding:24px 0">
      <input type="checkbox" id="c1" class="sr-only">
      <label for="c1"><svg width="20" height="20" viewBox="0 0 20 20"><path d="M0 0"/></svg>16-byte IP header</label>
    </div>
    <div class="answer" style="height:72px;padding:24px 0">
      <input type="checkbox" id="c2" class="sr-only">
      <label for="c2"><svg width="20" height="20" viewBox="0 0 20 20"><path d="M0 0"/></svg>4-byte GRE header</label>
    </div>
    <div class="answer" style="height:72px;padding:24px 0">
      <input type="checkbox" id="c3" class="sr-only">
      <label for="c3"><svg width="20" height="20" viewBox="0 0 20 20"><path d="M0 0"/></svg>20-byte IP header</label>
    </div>
  </div>
</main>
</body></html>`;

const dom = new JSDOM(html, { url: 'https://eksempel.dk/artikel', pretendToBeVisual: true, runScripts: 'outside-only' });
const { window } = dom;

window.scrollTo = () => {};
window.ClipboardItem = class { constructor(o) { this.parts = o; } };
window.chrome = {
  runtime: {
    sendMessage: async (msg) => {
      if (msg.type === 'INLINE_IMAGES') {
        return Object.fromEntries(msg.urls.map((u) => [u, 'data:image/png;base64,AAA']));
      }
      if (msg.type === 'CAPTURE_TAB') return null;
      return null;
    },
    onMessage: { addListener: () => {} }
  }
};
window.fetch = async () => { throw new Error('ingen net i testen'); };

for (const f of files) {
  window.eval(fs.readFileSync(path.join(ROOT, f), 'utf8'));
}

(async () => {
  const WF = window.__wf;
  const missing = ['util', 'state', 'text', 'ui', 'page', 'media', 'tables', 'quiz',
    'clean', 'images', 'capture', 'iframes', 'region', 'video', 'app',
    'diagnose'].filter((m) => !WF[m]);
  if (missing.length) throw new Error('moduler mangler: ' + missing);
  console.log('moduler indlæst:', WF.version, '– __webfang:', typeof window.__webfang.start);

  // Gen-indsprøjtning må ikke bygge alting op igen.
  const before = window.__wf;
  for (const f of files) window.eval(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  console.log('gen-indsprøjtning genbruger navnerum:', before === window.__wf);

  // Afkrydsning sat som DOM-egenskab (sådan som en side gør det), ikke som
  // attribut – klonen kan kun se den via den levende side.
  window.document.getElementById('c2').checked = true;

  WF.ui.mount();
  WF.state.currentEl = window.document.querySelector('main');
  WF.state.phase = 'selected';
  await WF.capture.prepare();

  const p = WF.state.prepared;
  if (!p) throw new Error('intet klip blev forberedt');
  const out = p.html;
  const check = (navn, ok) => console.log((ok ? '  ok  ' : ' FEJL ') + navn);
  check('overskrift med', /Overskrift/.test(out));
  check('brødtekst med', /Første afsnit/.test(out));
  check('nav-link fjernet', !/Return to Course/.test(out));
  check('menu fjernet', !/>Menu</.test(out));
  check('rigtigt link bevaret', /eksempel\.dk\/side/.test(out));
  check('billede indlejret', /src="data:image\/png/.test(out));
  check('quiz-svar som punkter', /Svar et/.test(out) && /Svar to/.test(out));
  check('valgt svar markeret', /✓/.test(out));
  // To quizzer på siden: radio-listen (2 svar) og afkrydsnings-listen (3 svar).
  check('quiz talt', WF.state.lastQuizCount === 5 && WF.state.lastQuizGroups >= 2);
  check('ARIA-tabel blev <table>', (out.match(/<table/g) || []).length >= 2);
  check('tabel-streger', /border-collapse/.test(out));
  check('udfoldet <details>-tekst med', /Skjult tekst/.test(out));
  check('styreknap væk', !/Submit/.test(out));
  check('afkrydset svar markeret (kun live .checked)', /✓ 4-byte GRE header/.test(out));
  check('uafkrydsede svar ikke markeret', !/✓ 16-byte IP header/.test(out));
  check('afkrydsnings-ikon ikke med', !/<svg/i.test(out));
  check('sidens højde-styles væk', !/height:\s*72px/.test(out) && !/padding:\s*24px/.test(out));
  check('vores egne afstande beholdt', /margin:2px 0/.test(out));
  check('mærke ikke med i klippet', !/data-wf=/.test(out));

  // Iframe: klonen får en pladsholder, rammen spørges via postMessage, og dens
  // svar sættes ind. Rammen selv (den anden side af samtalen) står her som en
  // stub – jsdom kører ikke vores content-script i indlejrede dokumenter.
  const ifr = window.document.createElement('iframe');
  ifr.src = 'https://eksempel.dk/ramme';
  window.document.querySelector('main').appendChild(ifr);
  const cw = ifr.contentWindow;
  if (!cw) throw new Error('jsdom gav ingen contentWindow');
  let gotReq = null;
  cw.postMessage = (msg) => {
    gotReq = msg;
    window.dispatchEvent(new window.MessageEvent('message', {
      data: { __webfang_frame: 'RES', id: msg.id, html: '<p>Indhold fra rammen</p>' }
    }));
  };
  await WF.capture.prepare();
  const framed = WF.state.prepared.html;
  check('ramme blev spurgt', !!gotReq && gotReq.__webfang_frame === 'REQ');
  check('ramme-indhold indsat i klippet', /Indhold fra rammen/.test(framed));
  check('ingen pladsholder tilbage', !/data-wf-iframe|⧉/.test(framed));
  check('<iframe> ikke i klippet', !/<iframe/i.test(framed));

  // En ramme der ikke svarer må ikke efterlade et tegn i klippet.
  cw.postMessage = (msg) => {
    window.dispatchEvent(new window.MessageEvent('message', {
      data: { __webfang_frame: 'RES', id: msg.id, html: '' }
    }));
  };
  await WF.capture.prepare();
  check('tavs ramme efterlader intet', !/⧉/.test(WF.state.prepared.html));
  ifr.remove();
  await WF.capture.prepare();

  // Diagnosen må hverken ændre siden eller den tilstand optaget bruger.
  const htmlBefore = window.document.body.innerHTML;
  const framesBefore = WF.state.pendingFrames;
  const report = window.__webfang.diagnose();
  check('diagnose svarer', typeof report === 'string' && /Webfang v/.test(report));
  check('diagnose måler oprydningen', /efter oprydning/.test(report));
  check('diagnose rører ikke siden', window.document.body.innerHTML === htmlBefore);
  check('diagnose rører ikke tilstanden', WF.state.pendingFrames === framesBefore);

  // Løbenummer: en ny forberedelse afbryder den forrige.
  const first = WF.capture.prepare();
  const second = WF.capture.prepare();
  await Promise.all([first, second]);
  check('afbrudt kørsel overskriver ikke', !!WF.state.prepared);

  console.log('\nstatus-linje:', WF.ui.status.textContent);

  // Delte sider: står opgaven i ét panel og scenariet i et andet ved siden af,
  // må valget ikke tage det ene og efterlade det andet. Kræver mål på
  // elementerne, som jsdom ikke selv laver – derfor en fast kasse til sidst.
  window.Element.prototype.getBoundingClientRect = () => ({
    width: 600, height: 600, top: 0, left: 0, right: 600, bottom: 600, x: 0, y: 0
  });
  const long = (s) => (s + ' ').repeat(60);
  const panels = window.document.createElement('div');
  panels.innerHTML = '<div id="venstre"><p>' + long('opgaven her') +
    '</p></div><div id="midt"><p>' + long('scenariet i midterpanelet') + '</p></div>';
  window.document.body.appendChild(panels);
  const root = WF.page.pickMainRoot();
  check('hoved-rod tager begge paneler med',
    root.contains(window.document.getElementById('midt')) &&
    root.contains(window.document.getElementById('venstre')));
})().catch((e) => { console.error('SMOKE FEJL:', e); process.exit(1); });
