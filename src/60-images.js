// Billeder: find dem, hent dem, og læg dem ind som data-URI'er.
//
// Et billede der ikke bliver indlejret, ender som et LINKET billede i Word –
// det peger tilbage på nettet og overskygger et hyperlink man selv sætter på
// billedet. Derfor fire forsøg, fra bedst til sidste udvej.
(() => {
  const WF = window.__wf;
  if (!WF || !WF.def) return;

  WF.def('images', (WF) => {
    const { sleep, loadImage, absUrl } = WF.util;

    const MAX_BLOB = 12 * 1024 * 1024;   // samme grænse som baggrunds-workeren

    // Skærmklip er dyrt: hvert billede skal scrolles ind, fotograferes og
    // vente på kvoten (~0,8 s pr. stk.), og siden hopper rundt imens. På
    // "Hele siden" kan der stå 40 billeder tilbage, og så ville optaget tage et
    // halvt minut mens siden bliver bygget om under os. Vi redder de første og
    // lader resten blive til linkede billeder.
    const MAX_SCREENSHOT_RESCUES = 8;

    // ---- Find URL'er -------------------------------------------------------

    function bestImageUrl(img) {
      const attrs = ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-lazy'];
      for (const name of attrs) {
        const v = img.getAttribute(name);
        if (v && !v.startsWith('data:') && v.trim()) {
          const abs = absUrl(v);
          if (abs) return abs;
        }
      }
      // srcset: vælg den største kandidat.
      const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
      if (srcset) {
        const best = srcset.split(',')
          .map((s) => s.trim().split(/\s+/))
          .map(([u, d]) => ({ u, w: parseInt(d) || 0 }))
          .sort((a, b) => b.w - a.w)[0];
        if (best && best.u) {
          const abs = absUrl(best.u);
          if (abs) return abs;
        }
      }
      return null;
    }

    function collectImageUrls(root) {
      const set = new Set();
      root.querySelectorAll('img').forEach((img) => {
        const u = bestImageUrl(img);
        if (u) { img.setAttribute('data-akurl', u); set.add(u); }
      });
      return [...set];
    }

    function applyImages(root, map) {
      root.querySelectorAll('img').forEach((img) => {
        const u = img.getAttribute('data-akurl');
        if (u) {
          img.setAttribute('src', map[u] || u);
          img.removeAttribute('data-akurl');
        }
        ['srcset', 'data-src', 'data-srcset', 'data-original', 'data-lazy-src', 'data-lazy', 'loading']
          .forEach((a) => img.removeAttribute(a));
        // Sørg for at billeder ikke sprænger sidebredden ved paste.
        const style = img.getAttribute('style') || '';
        if (!/max-width/.test(style)) {
          img.setAttribute('style', (style + ';max-width:100%;height:auto;').replace(/^;/, ''));
        }
      });
    }

    // ---- Forsøg 1: baggrunds-workeren --------------------------------------

    async function fromWorker(urls) {
      try {
        return await chrome.runtime.sendMessage({ type: 'INLINE_IMAGES', urls }) || {};
      } catch (_) {
        return {};
      }
    }

    // ---- Forsøg 2: sidens egen kontekst ------------------------------------

    const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });

    // Nogle CDN'er (fx Cisco's e-learning) kræver sidens cookies OG referer, og
    // dem har kun sidens egen kontekst.
    async function fromPage(urls) {
      const out = {};
      await Promise.all(urls.map(async (url) => {
        // Med cookies først. Fejler det, så uden: et CDN der svarer
        // "Access-Control-Allow-Origin: *" afviser netop de kald der sender
        // cookies med, og så er et anonymt kald det der lykkes.
        for (const credentials of ['include', 'omit']) {
          try {
            const res = await fetch(url, { credentials });
            if (!res.ok) continue;
            const blob = await res.blob();
            if (blob.size > MAX_BLOB) return;
            out[url] = await blobToDataUrl(blob);
            return;
          } catch (_) {
            // Blokeret af CORS → prøv næste variant, ellers original-URL.
          }
        }
      }));
      return out;
    }

    // ---- Forsøg 3: canvas ---------------------------------------------------

    // Det levende <img> på siden der svarer til en URL vi har samlet op.
    function liveImageFor(url) {
      for (const img of document.images) {
        if (img.currentSrc === url || img.src === url || bestImageUrl(img) === url) return img;
      }
      return null;
    }

    // Mal et allerede indlæst billede over på et canvas og læs det ud igen.
    // Kaster SecurityError hvis billedet er fremmed-origin uden CORS ("tainted").
    // Fotos skrives som JPEG – en PNG af et foto fylder mangedobbelt, og hele
    // klippet skal kunne ligge på udklipsholderen.
    function canvasDataUrl(img, url) {
      // Meget store billeder skaleres ned; 2000 px er rigeligt til et dokument.
      const scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      return /\.jpe?g(\?|$)/i.test(url)
        ? c.toDataURL('image/jpeg', 0.92)
        : c.toDataURL('image/png');
    }

    // Billedet står jo tegnet på siden. Virker uanset om serveren afviser selve
    // hentningen (fx 403 på grund af manglende referer), så længe billedet er
    // samme-origin eller CORS-venligt.
    async function fromCanvas(urls) {
      const out = {};
      await Promise.all(urls.map(async (url) => {
        const live = liveImageFor(url);
        if (!live || !live.naturalWidth) return;
        try {
          out[url] = canvasDataUrl(live, url);
          return;
        } catch (_) {
          // Tainted canvas → prøv at hente billedet igen som CORS-anmodning.
        }
        try {
          out[url] = canvasDataUrl(await loadImage(url, 'anonymous'), url);
        } catch (_) {
          // Serveren sender ingen CORS-headers → skærmklippet er tilbage.
        }
      }));
      return out;
    }

    // ---- Forsøg 4: skærmklip -----------------------------------------------

    // Det koster opløsning (skærmens, ikke filens), men et billede i klippet er
    // bedre end et dødt link – og et fremmed-origin billede uden CORS kan ikke
    // læses ud af et canvas overhovedet.
    async function fromScreenshot(urls, alive) {
      const out = {};
      const scrollY = window.scrollY;
      let n = 0;
      for (const url of urls) {
        if (n >= MAX_SCREENSHOT_RESCUES) {
          console.warn('Webfang: for mange billeder til skærmklip – springer resten over',
            urls.length - n);
          break;
        }
        const live = liveImageFor(url);
        if (!live) continue;
        n++;
        try {
          const data = await WF.media.screenshotElement(live);
          if (data) out[url] = data;
        } catch (_) {
          // Kunne ikke fotograferes → billedet beholder sin original-URL.
        }
        // captureVisibleTab er kvoteret til et par kald i sekundet.
        await sleep(550);
        if (alive && !alive()) break;
      }
      // Læg udsigten tilbage hvor brugeren havde den.
      window.scrollTo(0, scrollY);
      return out;
    }

    // ---- Samlet -------------------------------------------------------------

    // Kør alle forsøg efter tur, og giv kun de manglende videre til det næste.
    async function resolveImages(urls, alive) {
      const map = {};
      if (!urls.length) return map;
      const missing = () => urls.filter((u) => !map[u]);

      Object.assign(map, await fromWorker(urls));
      if (alive && !alive()) return map;

      if (missing().length) Object.assign(map, await fromPage(missing()));
      if (alive && !alive()) return map;

      if (missing().length) Object.assign(map, await fromCanvas(missing()));
      if (alive && !alive()) return map;

      // Skærmklip regner i tabbens koordinater; inde i en iframe passer de ikke,
      // og udsnittet ville blive taget et tilfældigt sted på siden.
      if (missing().length && !WF.util.inFrame) {
        Object.assign(map, await fromScreenshot(missing(), alive));
      }

      const failed = missing();
      if (failed.length) console.warn('Webfang: kunne ikke indlejre', failed);
      return map;
    }

    WF.images = {
      bestImageUrl, collectImageUrls, applyImages, liveImageFor, resolveImages
    };
  });
})();
