// DASH-playliste (.mpd) → liste over segmenter der skal hentes.
//
// DASH lægger ofte video og lyd i hver sin stream, som skal blandes sammen for
// at give én fil. Det gør vi ikke – vi henter dem hver for sig og siger det
// tydeligt. Ligger video og lyd i samme stream (muxed), bliver det én fil.

function parseMpd(xmlText, mpdUrl) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Kunne ikke læse .mpd-filen');

  const mpd = doc.documentElement;
  if (mpd.getAttribute('type') === 'dynamic') {
    throw new Error('Live-DASH understøttes ikke');
  }

  const total = parseDuration(mpd.getAttribute('mediaPresentationDuration'));
  const period = mpd.querySelector('Period');
  if (!period) throw new Error('Ingen Period i .mpd-filen');
  const periodDur = parseDuration(period.getAttribute('duration')) || total;

  // BaseURL nedarves ned gennem MPD → Period → AdaptationSet → Representation.
  const baseAt = (el, parentBase) => {
    const b = [...el.children].find((c) => c.tagName === 'BaseURL');
    return b ? abs(b.textContent.trim(), parentBase) : parentBase;
  };
  const mpdBase = baseAt(mpd, mpdUrl);
  const periodBase = baseAt(period, mpdBase);

  // Vælg bedste video og bedste lyd.
  const best = { video: null, audio: null };
  for (const as of period.querySelectorAll('AdaptationSet')) {
    const asBase = baseAt(as, periodBase);
    for (const rep of as.querySelectorAll('Representation')) {
      const kind = streamKind(as, rep);
      const bw = Number(rep.getAttribute('bandwidth') || 0);
      if (!best[kind] || bw > best[kind].bandwidth) {
        best[kind] = {
          bandwidth: bw,
          kind,
          id: rep.getAttribute('id') || '',
          width: rep.getAttribute('width') || '',
          height: rep.getAttribute('height') || '',
          rep, as,
          base: baseAt(rep, asBase)
        };
      }
    }
  }

  const streams = [];
  for (const kind of ['video', 'audio']) {
    if (!best[kind]) continue;
    const s = best[kind];
    streams.push({
      kind: s.kind,
      label: s.height ? `${s.height}p` : s.bandwidth ? `${Math.round(s.bandwidth / 1000)} kbps` : kind,
      ...segmentsFor(s, periodDur)
    });
  }
  if (!streams.length) throw new Error('Ingen brugbare streams i .mpd-filen');

  // Er lyden allerede med i video-streamen, skal vi ikke hente den to gange.
  const muxed = streams.length === 2 &&
    streams[0].segments.length && streams[1].segments.length &&
    streams[0].segments[0].url === streams[1].segments[0].url;

  return { streams: muxed ? [streams[0]] : streams };
}

function streamKind(as, rep) {
  const mime = (rep.getAttribute('mimeType') || as.getAttribute('mimeType') || '').toLowerCase();
  const ct = (as.getAttribute('contentType') || '').toLowerCase();
  if (mime.startsWith('audio') || ct === 'audio') return 'audio';
  return 'video';
}

// Find segmenterne for én representation. DASH har tre måder at beskrive dem på.
function segmentsFor(s, periodDur) {
  const tpl = pick(s.rep, s.as, 'SegmentTemplate');
  if (tpl) return fromTemplate(tpl, s, periodDur);

  const list = pick(s.rep, s.as, 'SegmentList');
  if (list) return fromList(list, s);

  // SegmentBase (eller slet ingenting): hele streamen ligger i én fil, som vi
  // bare kan hente direkte.
  return { init: null, segments: [{ url: s.base, byterange: null }], single: true };
}

const pick = (rep, as, tag) =>
  rep.querySelector(':scope > ' + tag) || as.querySelector(':scope > ' + tag);

function fromTemplate(tpl, s, periodDur) {
  const timescale = Number(tpl.getAttribute('timescale') || 1);
  const media = tpl.getAttribute('media') || '';
  const initTpl = tpl.getAttribute('initialization');
  const startNumber = Number(tpl.getAttribute('startNumber') || 1);

  const vars = { RepresentationID: s.id, Bandwidth: String(s.bandwidth) };
  const init = initTpl
    ? { url: abs(fill(initTpl, vars), s.base), byterange: null } : null;

  const segments = [];
  const timeline = tpl.querySelector('SegmentTimeline');

  if (timeline) {
    // Eksplicit tidslinje: <S t="" d="" r=""/>, hvor r er ANTAL GENTAGELSER.
    let t = 0, number = startNumber;
    for (const S of timeline.querySelectorAll('S')) {
      const st = S.getAttribute('t');
      if (st !== null) t = Number(st);
      const d = Number(S.getAttribute('d') || 0);
      const r = Number(S.getAttribute('r') || 0);
      for (let i = 0; i <= r; i++) {
        segments.push({
          url: abs(fill(media, { ...vars, Number: number, Time: t }), s.base),
          byterange: null
        });
        t += d; number++;
      }
    }
  } else {
    // Fast segmentlængde: udled antallet af Period'ens varighed.
    const d = Number(tpl.getAttribute('duration') || 0);
    if (!d || !periodDur) throw new Error('Kan ikke udlede antal segmenter fra .mpd-filen');
    const count = Math.ceil(periodDur / (d / timescale));
    for (let i = 0; i < count; i++) {
      segments.push({
        url: abs(fill(media, { ...vars, Number: startNumber + i, Time: i * d }), s.base),
        byterange: null
      });
    }
  }

  return { init, segments };
}

function fromList(list, s) {
  const initEl = list.querySelector('Initialization');
  const init = initEl && initEl.getAttribute('sourceURL')
    ? { url: abs(initEl.getAttribute('sourceURL'), s.base), byterange: range(initEl.getAttribute('range')) }
    : null;
  const segments = [...list.querySelectorAll('SegmentURL')].map((u) => ({
    url: abs(u.getAttribute('media') || '', s.base),
    byterange: range(u.getAttribute('mediaRange'))
  }));
  return { init, segments };
}

// $Number%05d$ → 00042. $$ er ét escapet dollartegn (to tegn, ikke tre) og
// skal derfor matches for sig, før de rigtige pladsholdere.
function fill(tpl, vars) {
  return tpl.replace(/\$\$|\$([A-Za-z]+)(%0(\d+)d)?\$/g, (m, name, fmt, width) => {
    if (m === '$$') return '$';
    const v = vars[name];
    if (v === undefined) return m;
    return width ? String(v).padStart(Number(width), '0') : String(v);
  });
}

// ISO 8601-varighed, fx PT1H2M3.5S → sekunder.
function parseDuration(s) {
  if (!s) return 0;
  const m = s.match(/^P(?:([\d.]+)Y)?(?:([\d.]+)M)?(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/);
  if (!m) return 0;
  const n = (x) => Number(x || 0);
  return n(m[1]) * 31536000 + n(m[2]) * 2592000 + n(m[3]) * 86400 +
    n(m[4]) * 3600 + n(m[5]) * 60 + n(m[6]);
}

function range(s) {
  if (!s) return null;
  const [a, b] = s.split('-').map(Number);
  return { offset: a, length: b - a + 1 };
}

function abs(u, base) {
  try { return new URL(u, base).href; } catch (_) { return u; }
}
