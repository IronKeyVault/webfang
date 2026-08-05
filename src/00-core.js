// Webfang – fundament for alle content-script-moduler.
//
// Modulerne indsprøjtes som en RÆKKE filer (manifest + chrome.scripting), og de
// deler ét navnerum: window.__wf. Hver fil registrerer sig med WF.def(navn, fn),
// så en gen-indsprøjtning på en side der allerede har koden, lydløst springer
// over i stedet for at bygge alting op igen oven i sig selv.
//
// Versioneret vagt: en side der stod åben da udvidelsen blev opdateret, har
// stadig det GAMLE script kørende. Uden versionsnummer ville en ny indsprøjtning
// blive afvist, og nye funktioner ville lydløst ikke virke.
(() => {
  const VERSION = 31;
  if (window.__wf && window.__wf.version >= VERSION) return;

  const WF = { version: VERSION, _mods: Object.create(null) };

  // Registrér et modul. Kaldes fn kun første gang navnet ses, kan de samme
  // filer indsprøjtes igen uden bivirkninger.
  WF.def = (name, fn) => {
    if (WF._mods[name]) return;
    WF._mods[name] = true;
    fn(WF);
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Koden kører også i sidens iframes (manifest: all_frames). Det meste er ens,
  // men alt der bruger SKÆRMEN – captureVisibleTab-udsnit – regner i tabbens
  // koordinater, og dem kender en indlejret ramme ikke. De trin springes over
  // i en ramme i stedet for at levere et forkert udsnit.
  const inFrame = (() => {
    try { return window.top !== window; } catch (_) { return true; }
  })();

  // Sammenklemt tekst – al sammenligning af tekst i koden bruger denne form.
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  const textLen = (el) => norm(el && el.textContent).length;

  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);

  // Elementets kasse i DOKUMENT-koordinater, så den overlever at siden scroller.
  const docRect = (el) => {
    const r = el.getBoundingClientRect();
    return {
      left: r.left + window.scrollX, top: r.top + window.scrollY,
      right: r.right + window.scrollX, bottom: r.bottom + window.scrollY,
      width: r.width, height: r.height
    };
  };

  // Teksten i et LEVENDE element, opdelt i linjer efter hvor de faktisk står på
  // skærmen. Kode-blokke er tit bygget med hver linje i sit eget element og
  // UDEN linjeskift i selve teksten – linjerne findes kun i layoutet. Hverken
  // textContent (ser ingen linjer) eller innerText (afhænger af sidens CSS, som
  // vi ikke sender med) kan så genskabe dem, men geometrien kan: to tekststumper
  // der ikke deler lodret position, står på hver sin linje.
  const livePreText = (live) => {
    if (!live || !live.isConnected || !live.ownerDocument) return '';
    let walker, range;
    try {
      walker = live.ownerDocument.createTreeWalker(live, NodeFilter.SHOW_TEXT);
      range = live.ownerDocument.createRange();
    } catch (_) { return ''; }

    const lines = [];
    let top = null, line = '';
    while (walker.nextNode()) {
      const raw = walker.currentNode.nodeValue || '';
      if (!raw.trim()) continue;
      let r;
      try {
        range.selectNodeContents(walker.currentNode);
        r = range.getBoundingClientRect();
      } catch (_) { continue; }
      if (!r || (!r.width && !r.height)) continue;
      if (top !== null && Math.abs(r.top - top) > 3) { lines.push(line); line = ''; }
      line += raw;
      top = r.top;
    }
    if (line) lines.push(line);

    return lines.map((l) => l.replace(/\u00a0/g, ' ').replace(/\s+$/, '')).join('\n').trim();
  };

  // Samme opgave, men på KLONEN – uden adgang til siden. Bruges når geometrien
  // ikke kan svare (den levende tvilling kan ikke findes). Linjerne læses af
  // strukturen: <br>, blok-elementer, og elementer hvis klasse siger "linje"
  // (highlightere som highlight.js lægger hver linje i sin egen
  // <span class="hljs-input-line">, helt uden linjeskift i teksten).
  const LINE_ISH = 'br, div, p, li, tr, [class*="line"]';

  const clonePreText = (el) => {
    const lines = [];
    let cur = '';
    const flush = () => { if (cur.trim()) lines.push(cur); cur = ''; };

    // `inLine` holder styr på at KUN den yderste linje-agtige knude bryder.
    // Highlightere pakker prompt og kommando i hver sit element inde i samme
    // linje, og uden det ville "R4(config)# interface tunnel0" blive til to.
    const walk = (node, inLine) => {
      node.childNodes.forEach((n) => {
        if (n.nodeType === 3) { cur += n.nodeValue; return; }
        if (n.nodeType !== 1) return;
        if (n.tagName === 'BR') { flush(); return; }
        let lineish = false;
        try { lineish = !inLine && n.matches(LINE_ISH); } catch (_) {}
        if (lineish) flush();
        walk(n, inLine || lineish);
        if (lineish) flush();
      });
    };
    walk(el, false);
    flush();

    return lines.map((l) => l.replace(/\u00a0/g, ' ').replace(/\s+$/, '')).join('\n').trim();
  };

  // Flerlinjet tekst ind i et element – som tekst og <br>, ikke som linjeskift.
  //
  // Word læser vores inline styles, men IKKE white-space: den tager gerne
  // font-family fra et punkt og klemmer så alligevel linjerne sammen til én.
  // <br> er det eneste linjeskift Word altid respekterer. Derfor sættes
  // linjerne ind hver for sig, uden \n imellem (ellers ville en browser med
  // pre-wrap vise dobbelt luft).
  const setLines = (el, text) => {
    const lines = String(text).split('\n');
    lines.forEach((line, i) => {
      if (i) el.appendChild(el.ownerDocument.createElement('br'));
      el.appendChild(el.ownerDocument.createTextNode(line));
    });
    return el;
  };

  // Vores EGEN styling på et element vi selv har bygget. Mærket data-wf gør at
  // oprydningens slankning af sidens højde-/afstands-styles ikke tager vores
  // med – den ved ellers ikke hvem der har sat hvad.
  const setOwnStyle = (el, css) => {
    el.setAttribute('style', css);
    el.setAttribute('data-wf', '');
  };

  // rgb()/rgba() → [r,g,b]. Næsten gennemsigtige farver tæller som "ingen farve".
  const rgb = (c) => {
    const m = (c || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
    if (!m || (m[4] !== undefined && Number(m[4]) < 0.5)) return null;
    return [+m[1], +m[2], +m[3]];
  };

  // Mættet = ikke hvid/grå/sort.
  const saturated = (c) => {
    const v = rgb(c);
    return !!v && Math.max(...v) - Math.min(...v) > 30;
  };

  // Indlæs en data-/blob-URL som <img> (afviser hvis billedet ikke kan tegnes).
  const loadImage = (src, crossOrigin) => new Promise((resolve, reject) => {
    const i = new Image();
    if (crossOrigin) i.crossOrigin = crossOrigin;
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = src;
  });

  const absUrl = (u) => {
    try { return new URL(u, location.href).href; } catch (_) { return null; }
  };

  WF.util = {
    sleep, norm, textLen, esc, docRect, rgb, saturated, loadImage, absUrl, inFrame,
    setOwnStyle, setLines, livePreText, clonePreText
  };

  window.__wf = WF;
})();
