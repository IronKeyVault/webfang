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
  const VERSION = 25;
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
    setOwnStyle
  };

  window.__wf = WF;
})();
