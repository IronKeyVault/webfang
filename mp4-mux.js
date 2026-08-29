// Lægger et videospor og et lydspor sammen til én MP4-fil.
//
// Vimeo (og DASH) leverer sporene hver for sig, og hver af dem er en færdig,
// selvstændig MP4. At samle dem er ren ompakning: billed- og lyddata røres
// ikke, kun containeren bygges om. Ingen genkodning, intet kvalitetstab.
//
// Der findes to slags MP4, og de skal samles på hver sin måde:
//
//   Fragmenteret (fMP4) – det Vimeo leverer. Filen er `moov` efterfulgt af
//   tusindvis af `moof`+`mdat`-par, hvor hvert par er nogle få sekunder film.
//   `moof`en beskriver sine egne samples med offsets *relativt til sig selv*
//   (`tfhd`-flaget default-base-is-moof), så fragmenterne kan flyttes frit.
//   Sammenlægningen er derfor: ét nyt `moov` med begge spor, og derefter
//   begge filers fragmenter flettet sammen i tidsrækkefølge.
//
//   Progressiv – ét `moov` med fulde sample-tabeller, og ét stort `mdat`.
//   Her er `stco`/`co64` absolutte filpositioner, så når mediedata flyttes
//   bag et nyt, større `moov`, skal hvert eneste offset regnes om. Gør man
//   ikke det, har filen alle sine bytes og er alligevel ubrugelig.
//
// Ingen mediedata kopieres undervejs: de sendes videre som de stumper de
// allerede ligger i, så en 3½-times film ikke skal ligge i hukommelsen to
// gange for at blive samlet.

(() => {
  const MUX = {};

  const CONTAINERS = new Set([
    'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'mvex',
    'moof', 'traf'
  ]);

  // ---- Læsning på tværs af stumper ----------------------------------------
  //
  // En hentet fil ligger som mange små Uint8Array'er. Reader'en lader os læse
  // og udskære på tværs af dem, uden først at støbe dem sammen til én.

  function reader(parts) {
    const index = [];
    let total = 0;
    for (const p of parts) {
      if (!p.length) continue;
      index.push({ start: total, arr: p });
      total += p.length;
    }

    const findPart = (off) => {
      let lo = 0, hi = index.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (index[mid].start <= off) lo = mid; else hi = mid - 1;
      }
      return lo;
    };

    function read(off, len) {
      const out = new Uint8Array(len);
      let written = 0;
      let i = findPart(off);
      while (written < len && i < index.length) {
        const { start, arr } = index[i];
        const from = Math.max(0, off - start);
        const take = Math.min(arr.length - from, len - written);
        out.set(arr.subarray(from, from + take), written);
        written += take;
        i++;
      }
      if (written < len) throw new Error('filen slutter midt i en boks');
      return out;
    }

    // Udsnit som en liste af udsnit af de oprindelige stumper – ingen kopi.
    function slice(from, to) {
      const out = [];
      let i = findPart(from);
      let pos = from;
      while (pos < to && i < index.length) {
        const { start, arr } = index[i];
        const a = Math.max(0, pos - start);
        const b = Math.min(arr.length, to - start);
        if (b > a) { out.push(arr.subarray(a, b)); pos = start + b; }
        i++;
      }
      return out;
    }

    return { total, read, slice };
  }

  // ---- Boks-værktøj --------------------------------------------------------

  const u32 = (b, o) => (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
  const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
  const type4 = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

  function setU32(b, o, v) {
    b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255;
    b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255;
  }

  function setU64(b, o, v) {
    setU32(b, o, Math.floor(v / 4294967296));
    setU32(b, o + 4, v >>> 0);
  }

  function boxes(bytes, from = 0, to = bytes.length) {
    const out = [];
    let off = from;
    while (off + 8 <= to) {
      let size = u32(bytes, off);
      let header = 8;
      const t = type4(bytes, off + 4);
      if (size === 1) { size = u64(bytes, off + 8); header = 16; }
      else if (size === 0) size = to - off;
      if (size < header || off + size > to) break;
      out.push({ type: t, start: off, headerSize: header, size });
      off += size;
    }
    return out;
  }

  // Bokse på filens øverste niveau, uden at læse hele filen ind.
  function topBoxes(r) {
    const out = [];
    let off = 0;
    while (off + 8 <= r.total) {
      const head = r.read(off, Math.min(16, r.total - off));
      let size = u32(head, 0);
      let header = 8;
      const t = type4(head, 4);
      if (size === 1) { size = u64(head, 8); header = 16; }
      else if (size === 0) size = r.total - off;
      if (size < header) break;
      out.push({ type: t, start: off, headerSize: header, size });
      off += size;
    }
    return out;
  }

  const find = (list, type) => list.find((b) => b.type === type);

  // Bokse i et udsnit af filen, uden at læse udsnittet ind.
  function topBoxesIn(r, from, to) {
    const out = [];
    let off = from;
    while (off + 8 <= to) {
      const head = r.read(off, Math.min(16, to - off));
      let size = u32(head, 0);
      let header = 8;
      const t = type4(head, 4);
      if (size === 1) { size = u64(head, 8); header = 16; }
      else if (size === 0) size = to - off;
      if (size < header || off + size > to) break;
      out.push({ type: t, start: off, headerSize: header, size });
      off += size;
    }
    return out;
  }

  function findDeep(bytes, type, from = 0, to = bytes.length) {
    for (const b of boxes(bytes, from, to)) {
      if (b.type === type) return b;
      if (CONTAINERS.has(b.type)) {
        const hit = findDeep(bytes, type, b.start + b.headerSize, b.start + b.size);
        if (hit) return hit;
      }
    }
    return null;
  }

  // Bygger en boks af færdige dele.
  function makeBox(type, children) {
    let body = 0;
    for (const c of children) body += c.length;
    const out = new Uint8Array(8 + body);
    setU32(out, 0, out.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let at = 8;
    for (const c of children) { out.set(c, at); at += c.length; }
    return out;
  }

  const copyOf = (b) => Uint8Array.prototype.slice.call(b);

  // ---- Indlæsning af en fil ------------------------------------------------

  function openFile(parts, what) {
    const r = reader(parts);
    const top = topBoxes(r);
    const moovBox = find(top, 'moov');
    if (!moovBox) throw new Error(`fandt ingen moov i ${what}`);

    const moov = r.read(moovBox.start, moovBox.size);
    const trakBox = find(boxes(moov, moovBox.headerSize, moov.length), 'trak');
    if (!trakBox) throw new Error(`fandt intet spor i ${what}`);

    const file = {
      what,
      ftyp: (() => {
        const f = find(top, 'ftyp');
        return f ? r.read(f.start, f.size) : defaultFtyp();
      })(),
      moov,
      moovHeader: moovBox.headerSize,
      trak: moov.subarray(trakBox.start, trakBox.start + trakBox.size),
      mediaTimescale: readTimescale(moov, trakBox)
    };
    Object.assign(file, readMovieHeader(file));

    // Fragmenteret? Så er filen moov + en række moof/mdat-par.
    const moofs = top.filter((b) => b.type === 'moof');
    if (moofs.length) {
      file.fragments = readFragments(r, top, moofs, file.mediaTimescale, what);
      file.timed = file.fragments.every((f) => f.timed);
      return file;
    }

    const mdats = top.filter((b) => b.type === 'mdat');
    if (!mdats.length) throw new Error(`fandt hverken moof eller mdat i ${what}`);
    const ranges = [];
    const media = [];
    let acc = 0;
    for (const m of mdats) {
      const from = m.start + m.headerSize;
      const to = m.start + m.size;
      ranges.push({ from, to, out: acc });
      acc += to - from;
      media.push(...r.slice(from, to));
    }
    file.fragments = null;
    file.ranges = ranges;
    file.mediaLength = acc;
    file.media = media;
    return file;
  }

  // Hvert fragment er sin moof plus alt indtil den næste moof. Kun moof'en
  // læses ind (den er små kilobyte); mediedata bliver liggende hvor de er.
  function readFragments(r, top, moofs, timescale, what) {
    const starts = moofs.map((m) => m.start);
    const out = [];
    for (let i = 0; i < moofs.length; i++) {
      const m = moofs[i];
      const end = i + 1 < starts.length ? starts[i + 1] : r.total;
      const moof = r.read(m.start, m.size);
      const tfdt = findDeep(moof, 'tfdt');
      let time = 0;
      let raw = 0;
      if (tfdt) {
        const version = moof[tfdt.start + 8];
        raw = version === 1 ? u64(moof, tfdt.start + 12) : u32(moof, tfdt.start + 12);
        time = timescale ? raw / timescale : raw;
      } else {
        time = i; // ingen tidsstempler: behold filens egen rækkefølge
      }

      // Både hele halen (moof + mdat, til den simple fletning) og mediedata
      // for sig (til den sammenlagte form, hvor de to spors data skal ligge
      // i ét fælles mdat).
      const media = r.slice(m.start + m.size, end);
      const data = [];
      let dataLength = 0;
      // Hvor fragmentets mediedata begynder, målt fra moof'ens start – det er
      // samme målestok som trun'ens data_offset, så de to kan regnes sammen.
      let dataStart = 0;
      for (const b of topBoxesIn(r, m.start + m.size, end)) {
        if (b.type !== 'mdat') continue;
        if (!dataLength) dataStart = b.start + b.headerSize - m.start;
        data.push(...r.slice(b.start + b.headerSize, b.start + b.size));
        dataLength += b.size - b.headerSize;
      }
      out.push({ moof, media, data, dataLength, dataStart, time, timeRaw: raw,
        timed: !!tfdt });
    }
    if (!out.length) throw new Error(`fandt ingen fragmenter i ${what}`);
    return out;
  }

  function defaultFtyp() {
    const b = new Uint8Array(24);
    setU32(b, 0, 24);
    b.set([0x66, 0x74, 0x79, 0x70], 4);
    b.set([0x69, 0x73, 0x6f, 0x6d], 8);
    setU32(b, 12, 512);
    b.set([0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x32], 16);
    return b;
  }

  function readMovieHeader(file) {
    const mvhd = findDeep(file.moov, 'mvhd', file.moovHeader, file.moov.length);
    if (!mvhd) return { timescale: 0, duration: 0 };
    const version = file.moov[mvhd.start + 8];
    return version === 1
      ? { timescale: u32(file.moov, mvhd.start + 28), duration: u64(file.moov, mvhd.start + 32) }
      : { timescale: u32(file.moov, mvhd.start + 20), duration: u32(file.moov, mvhd.start + 24) };
  }

  // Sporets egen tidsskala (mdhd) – den som tfdt måles i.
  function readTimescale(moov, trakBox) {
    const mdhd = findDeep(moov, 'mdhd', trakBox.start + trakBox.headerSize,
      trakBox.start + trakBox.size);
    if (!mdhd) return 0;
    const version = moov[mdhd.start + 8];
    return u32(moov, mdhd.start + (version === 1 ? 28 : 20));
  }

  // ---- Spor-numre og edit lists -------------------------------------------

  const trackIdOffset = (version) => version === 1 ? 28 : 20;

  function trackIdsIn(bytes, from, to) {
    const ids = [];
    for (const b of boxes(bytes, from, to)) {
      if (b.type !== 'trak') continue;
      const tkhd = findDeep(bytes, 'tkhd', b.start + b.headerSize, b.start + b.size);
      if (tkhd) ids.push(u32(bytes, tkhd.start + trackIdOffset(bytes[tkhd.start + 8])));
    }
    return ids;
  }

  function setTrackId(trak, id) {
    const tkhd = findDeep(trak, 'tkhd');
    if (tkhd) setU32(trak, tkhd.start + trackIdOffset(trak[tkhd.start + 8]), id);
  }

  // En edit list måler i filmens tidsskala, ikke sporets. Beholder vi videoens
  // mvhd, skal lydens edit list regnes om – ellers starter lyden forskudt.
  function rescaleEditList(trak, oldScale, newScale) {
    if (!oldScale || !newScale || oldScale === newScale) return;
    const elst = findDeep(trak, 'elst');
    if (!elst) return;
    const version = trak[elst.start + 8];
    const base = elst.start + elst.headerSize;
    const count = u32(trak, base + 4);
    const stride = version === 1 ? 20 : 12;
    for (let i = 0; i < count; i++) {
      const at = base + 8 + i * stride;
      if (version === 1) setU64(trak, at, Math.round(u64(trak, at) * newScale / oldScale));
      else setU32(trak, at, Math.round(u32(trak, at) * newScale / oldScale));
    }
  }

  // ---- Nyt moov ------------------------------------------------------------
  //
  // Bygges af videoens egne dele i den rækkefølge en MP4 forventer dem:
  // mvhd, sporene, mvex, og hvad videoen ellers havde med.

  function buildMoov(v, a, audioTrak, audioTrex, audioId) {
    const children = boxes(v.moov, v.moovHeader, v.moov.length);
    const mvhdBox = find(children, 'mvhd');
    const mvexBox = find(children, 'mvex');
    const out = [];

    let mvhd = null;
    if (mvhdBox) {
      mvhd = copyOf(v.moov.subarray(mvhdBox.start, mvhdBox.start + mvhdBox.size));
      patchMovieHeader(mvhd, v, a, audioId + 1);
      out.push(mvhd);
    }

    for (const c of children) {
      if (c.type === 'trak') out.push(v.moov.subarray(c.start, c.start + c.size));
    }
    out.push(audioTrak);

    if (mvexBox) {
      // mvex skal rumme en trex pr. spor, ellers ved afspilleren ikke hvordan
      // lydens fragmenter skal læses.
      const kids = [];
      for (const c of boxes(v.moov, mvexBox.start + mvexBox.headerSize,
        mvexBox.start + mvexBox.size)) {
        kids.push(v.moov.subarray(c.start, c.start + c.size));
      }
      if (audioTrex) kids.push(audioTrex);
      out.push(makeBox('mvex', kids));
    }

    for (const c of children) {
      if (c.type !== 'mvhd' && c.type !== 'trak' && c.type !== 'mvex') {
        out.push(v.moov.subarray(c.start, c.start + c.size));
      }
    }

    return makeBox('moov', out);
  }

  function patchMovieHeader(mvhd, v, a, nextId) {
    const version = mvhd[8];
    const durAt = version === 1 ? 32 : 24;
    const scaled = a.timescale && v.timescale
      ? a.duration * v.timescale / a.timescale : a.duration;
    const dur = Math.round(Math.max(v.duration, scaled));
    if (version === 1) setU64(mvhd, durAt, dur); else setU32(mvhd, durAt, dur);
    setU32(mvhd, mvhd.length - 4, nextId); // next_track_ID står sidst
  }

  // ---- Fragmenteret sammenlægning -----------------------------------------

  function muxFragmented(v, a) {
    const used = trackIdsIn(v.moov, v.moovHeader, v.moov.length);
    const audioId = (used.length ? Math.max(...used) : 0) + 1;

    const audioTrak = copyOf(a.trak);
    setTrackId(audioTrak, audioId);
    rescaleEditList(audioTrak, a.timescale, v.timescale);

    const aTrexBox = findDeep(a.moov, 'trex', a.moovHeader, a.moov.length);
    let audioTrex = null;
    if (aTrexBox) {
      audioTrex = copyOf(a.moov.subarray(aTrexBox.start, aTrexBox.start + aTrexBox.size));
      setU32(audioTrex, 12, audioId); // trex: version+flags, så track_ID
    }

    const parts = [v.ftyp, buildMoov(v, a, audioTrak, audioTrex, audioId)];

    // Videoens opdeling beholdes, og lyden skæres om så hvert moof bærer
    // samme stykke tid i begge spor. Det kræver at begge spor har rigtige
    // tidsstempler; uden dem er et fragments `time` blot dets nummer (se
    // readFragments), og så er der intet at skære efter.
    if (v.timed && a.timed && canCombine(v.fragments) && canCombine(a.fragments)) {
      appendCoTimed(parts, v.fragments, a.fragments, audioId,
        a.mediaTimescale, trexDefaults(a));
      return parts;
    }

    // Kan trafs ikke flyttes (en trun uden data-offset), fletter vi i det
    // mindste fragmenterne i tidsrækkefølge, så filen er brugbar.
    appendInterleaved(parts, v.fragments, a.fragments, audioId);
    return parts;
  }

  // En traf kan kun flyttes hvis dens trun selv siger hvor data begynder.
  function canCombine(fragments) {
    return fragments.every((f) => {
      const traf = findDeep(f.moof, 'traf');
      if (!traf) return false;
      const trun = findDeep(f.moof, 'trun', traf.start + traf.headerSize,
        traf.start + traf.size);
      return !!trun && (u32(f.moof, trun.start + 8) & 0x000001) !== 0;
    });
  }

  function trafsOf(moof) {
    return boxes(moof, 8, moof.length)
      .filter((b) => b.type === 'traf')
      .map((b) => copyOf(moof.subarray(b.start, b.start + b.size)));
  }

  // Fortæl at data_offset måles fra moof'ens begyndelse.
  //
  // Uden tfhd-flaget default-base-is-moof siger ISO-standarden noget andet:
  // FØRSTE traf i et moof måles fra moof-starten, men de følgende måles fra
  // hvor det forrige spors data sluttede. Ligger video og lyd i samme moof,
  // rammer video derfor rigtigt mens lyden læses langt inde i filen – lyden
  // er i filen, den bliver bare hentet det forkerte sted fra, og resultatet
  // er tavshed. Så længe hvert moof kun rummede ét spor, kunne fejlen ikke ses.
  function setBaseIsMoof(traf) {
    const tfhd = findDeep(traf, 'tfhd');
    if (!tfhd) return;
    // Ordet rummer version (øverste byte) og flags – vi rører kun ét flag.
    const at = tfhd.start + 8;
    setU32(traf, at, (u32(traf, at) | 0x020000) >>> 0);
  }

  function trunsIn(bytes, from, to) {
    const truns = [];
    (function walk(a, b) {
      for (const box of boxes(bytes, a, b)) {
        if (box.type === 'trun') truns.push(box);
        else if (CONTAINERS.has(box.type)) walk(box.start + box.headerSize, box.start + box.size);
      }
    })(from, to);
    return truns;
  }

  const trunsOf = (traf) => trunsIn(traf, 8, traf.length);

  // Flytter et fragments trafs, så dets mediedata begynder på `newOffset`
  // regnet fra moof'ens start. Alle offsets flyttes med det SAMME spring, så
  // sporenes indbyrdes placering inde i fragmentets data er uændret – ellers
  // ville et fragment med mere end én traf få dem oven i hinanden.
  function shiftFragment(trafs, newOffset) {
    let delta = null;
    for (const traf of trafs) {
      setBaseIsMoof(traf);
      for (const trun of trunsOf(traf)) {
        if ((u32(traf, trun.start + 8) & 0x000001) === 0) continue;
        const at = trun.start + 16;
        const old = (u32(traf, at) | 0);         // data_offset er fortegnsbærende
        if (delta === null) delta = newOffset - old;
        setU32(traf, at, (old + delta) >>> 0);
      }
    }
  }

  function mfhdBox(seq) {
    const b = new Uint8Array(16);
    setU32(b, 0, 16);
    b.set([0x6d, 0x66, 0x68, 0x64], 4); // 'mfhd'
    setU32(b, 12, seq);
    return b;
  }

  function mdatHeaderFor(length) {
    const h = new Uint8Array(8);
    setU32(h, 0, 8 + length);
    h.set([0x6d, 0x64, 0x61, 0x74], 4); // 'mdat'
    return h;
  }

  // ---- Lyden skæres om, så et moof dækker samme tid i begge spor ----------
  //
  // Videoens og lydens fragmenter er sjældent lige lange – her 6,000 s mod
  // 5,99467 s. Lægger man dem sammen som de kommer, beskriver de to trafs i ét
  // moof derfor hver sit stykke tid. Parret på indeks voksede forskellen til
  // 12 s; selv med nærmeste nabo stod der 1,6–3 s tilbage. VLC hakkede og
  // tabte små stumper lyd af netop dét, mens Edge ikke opdagede noget.
  //
  // Ét spor pr. moof fjerner forskydningen, men den form gengiver VLC ikke
  // lyden af overhovedet – filen er tavs, selv om alle bytes er der.
  //
  // Så tilbage står det ffmpeg gør: behold videoens opdeling, og skær lyden om
  // så hvert moof bærer præcis de lydsamples der hører til dét stykke film.
  // Kun sample-TABELLEN skrives om; lyddataene sendes videre som de udsnit de
  // allerede ligger i, så intet omkodes og intet kopieres.

  // trex bærer de fælles standardværdier, som en traf må nøjes med at henvise
  // til i stedet for at gentage dem for hver sample.
  function trexDefaults(file) {
    const trex = findDeep(file.moov, 'trex', file.moovHeader, file.moov.length);
    if (!trex) return { duration: 0, size: 0, flags: 0 };
    return {
      duration: u32(file.moov, trex.start + 20),
      size: u32(file.moov, trex.start + 24),
      flags: u32(file.moov, trex.start + 28)
    };
  }

  // Hver sample i et fragment, foldet ud: hvornår den begynder, hvor længe den
  // varer, hvor stor den er, og hvor i fragmentets data den ligger. Værdier
  // der ikke står i trun'en hentes fra tfhd'en, og ellers fra trex.
  function pushSamples(frag, defaults, table) {
    const moof = frag.moof;
    for (const trafBox of boxes(moof, 8, moof.length)) {
      if (trafBox.type !== 'traf') continue;
      const from = trafBox.start + trafBox.headerSize;
      const to = trafBox.start + trafBox.size;

      let defDur = defaults.duration;
      let defSize = defaults.size;
      let defFlags = defaults.flags;
      const tfhd = findDeep(moof, 'tfhd', from, to);
      if (tfhd) {
        const fl = u32(moof, tfhd.start + 8) & 0xffffff;
        let p = tfhd.start + 16;
        if (fl & 0x01) p += 8;                       // base_data_offset
        if (fl & 0x02) p += 4;                       // sample_description_index
        if (fl & 0x08) { defDur = u32(moof, p); p += 4; }
        if (fl & 0x10) { defSize = u32(moof, p); p += 4; }
        if (fl & 0x20) { defFlags = u32(moof, p); p += 4; }
      }

      let time = frag.timeRaw;
      for (const trun of trunsIn(moof, from, to)) {
        const fl = u32(moof, trun.start + 8) & 0xffffff;
        const count = u32(moof, trun.start + 12);
        let p = trun.start + 16;
        let at = 0;
        if (fl & 0x000001) { at = (u32(moof, p) | 0) - frag.dataStart; p += 4; }
        let firstFlags = null;
        if (fl & 0x000004) { firstFlags = u32(moof, p); p += 4; }
        for (let i = 0; i < count; i++) {
          let dur = defDur, size = defSize, sflags = defFlags, cts = 0;
          if (fl & 0x000100) { dur = u32(moof, p); p += 4; }
          if (fl & 0x000200) { size = u32(moof, p); p += 4; }
          if (fl & 0x000400) { sflags = u32(moof, p); p += 4; }
          if (fl & 0x000800) { cts = u32(moof, p) | 0; p += 4; }
          table.time.push(time);
          table.dur.push(dur);
          table.size.push(size);
          table.flags.push(i === 0 && firstFlags !== null ? firstFlags : sflags);
          table.cts.push(cts);
          table.frag.push(frag);
          table.pos.push(at);
          time += dur;
          at += size;
        }
      }
    }
  }

  // Udsnit af et fragments data, uden at kopiere: samples der ligger i
  // forlængelse af hinanden samles til ét udsnit.
  function sampleBytes(table, lo, hi) {
    const out = [];
    let bytes = 0;
    let i = lo;
    while (i < hi) {
      const frag = table.frag[i];
      const from = table.pos[i];
      let to = from + table.size[i];
      let j = i + 1;
      while (j < hi && table.frag[j] === frag && table.pos[j] === to) {
        to += table.size[j];
        j++;
      }
      let pos = 0;
      for (const part of frag.data) {
        const a = Math.max(from, pos);
        const b = Math.min(to, pos + part.length);
        if (b > a) out.push(part.subarray(a - pos, b - pos));
        pos += part.length;
        if (pos >= to) break;
      }
      bytes += to - from;
      i = j;
    }
    return { parts: out, bytes };
  }

  // En traf der beskriver samples [lo, hi) af tabellen. Alt står i trun'en, så
  // den er uafhængig af hvilke standardværdier kildens tfhd satte.
  function buildTraf(table, lo, hi, trackId) {
    const count = hi - lo;
    let hasCts = false;
    for (let i = lo; i < hi; i++) if (table.cts[i] !== 0) { hasCts = true; break; }

    const tfhd = new Uint8Array(16);
    setU32(tfhd, 0, 16);
    tfhd.set([0x74, 0x66, 0x68, 0x64], 4);           // 'tfhd'
    setU32(tfhd, 8, 0x020000);                       // default-base-is-moof
    setU32(tfhd, 12, trackId);

    const tfdt = new Uint8Array(20);
    setU32(tfdt, 0, 20);
    tfdt.set([0x74, 0x66, 0x64, 0x74], 4);           // 'tfdt'
    setU32(tfdt, 8, 0x01000000);                     // version 1: 64-bit tid
    setU64(tfdt, 12, table.time[lo]);

    // data-offset, varighed, størrelse og flag pr. sample – og cts kun hvis
    // nogen af dem har en. Version 1 gør cts fortegnsbærende.
    const flags = 0x000001 | 0x000100 | 0x000200 | 0x000400 | (hasCts ? 0x000800 : 0);
    const stride = 12 + (hasCts ? 4 : 0);
    const trun = new Uint8Array(20 + count * stride);
    setU32(trun, 0, trun.length);
    trun.set([0x74, 0x72, 0x75, 0x6e], 4);           // 'trun'
    setU32(trun, 8, (hasCts ? 0x01000000 : 0) | flags);
    setU32(trun, 12, count);
    setU32(trun, 16, 0);                             // sættes når moof'en er målt
    let p = 20;
    for (let i = lo; i < hi; i++) {
      setU32(trun, p, table.dur[i]); p += 4;
      setU32(trun, p, table.size[i]); p += 4;
      setU32(trun, p, table.flags[i]); p += 4;
      if (hasCts) { setU32(trun, p, table.cts[i] >>> 0); p += 4; }
    }
    return makeBox('traf', [tfhd, tfdt, trun]);
  }

  function appendCoTimed(parts, vFrags, aFrags, audioId, audioTimescale, defaults) {
    const table = { time: [], dur: [], size: [], flags: [], cts: [], frag: [], pos: [] };
    for (const f of aFrags) pushSamples(f, defaults, table);

    let seq = 1;
    let lo = 0;
    for (let g = 0; g < vFrags.length; g++) {
      const vf = vFrags[g];
      // Grænsen er næste videofragments start, målt i lydens tidsskala. Det
      // sidste moof tager resten, så en hale af lyd ikke falder på gulvet.
      const limit = g + 1 < vFrags.length
        ? vFrags[g + 1].time * audioTimescale : Infinity;
      let hi = lo;
      while (hi < table.time.length && table.time[hi] < limit) hi++;

      const trafs = trafsOf(vf.moof);
      const audio = hi > lo ? buildTraf(table, lo, hi, audioId) : null;

      const mfhd = mfhdBox(seq++);
      let moofSize = 8 + mfhd.length;
      for (const t of trafs) moofSize += t.length;
      if (audio) moofSize += audio.length;

      // Videoen først i det fælles mdat, lyden bagefter.
      shiftFragment(trafs, moofSize + 8);
      let extra = { parts: [], bytes: 0 };
      if (audio) {
        const trun = findDeep(audio, 'trun');
        setU32(audio, trun.start + 16, moofSize + 8 + vf.dataLength);
        extra = sampleBytes(table, lo, hi);
      }

      parts.push(makeBox('moof', audio ? [mfhd, ...trafs, audio] : [mfhd, ...trafs]),
        mdatHeaderFor(vf.dataLength + extra.bytes));
      parts.push(...vf.data, ...extra.parts);
      lo = hi;
    }
  }

  function appendInterleaved(parts, vFrags, aFrags, audioId) {
    const merged = [];
    let i = 0, j = 0;
    while (i < vFrags.length || j < aFrags.length) {
      const takeVideo = j >= aFrags.length ||
        (i < vFrags.length && vFrags[i].time <= aFrags[j].time);
      merged.push(takeVideo
        ? { f: vFrags[i++], audio: false }
        : { f: aFrags[j++], audio: true });
    }

    let seq = 1;
    for (const { f, audio } of merged) {
      const mfhd = findDeep(f.moof, 'mfhd');
      if (mfhd) setU32(f.moof, mfhd.start + 12, seq++);
      if (audio) {
        const tfhd = findDeep(f.moof, 'tfhd');
        if (tfhd) setU32(f.moof, tfhd.start + 12, audioId);
      }
      parts.push(f.moof, ...f.media);
    }
  }

  // ---- Progressiv sammenlægning -------------------------------------------

  function muxProgressive(v, a) {
    const used = trackIdsIn(v.moov, v.moovHeader, v.moov.length);
    const audioId = (used.length ? Math.max(...used) : 0) + 1;

    const audioTrak = copyOf(a.trak);
    setTrackId(audioTrak, audioId);
    rescaleEditList(audioTrak, a.timescale, v.timescale);

    const moov = buildMoov(v, a, audioTrak, null, audioId);

    // mdat skrives med 64-bit længde, så en lang film ikke render mod 4 GB.
    const mdatPayload = v.mediaLength + a.mediaLength;
    const mdatHeader = new Uint8Array(16);
    setU32(mdatHeader, 0, 1);
    mdatHeader.set([0x6d, 0x64, 0x61, 0x74], 4);
    setU64(mdatHeader, 8, 16 + mdatPayload);

    const videoMediaStart = v.ftyp.length + moov.length + 16;
    const audioMediaStart = videoMediaStart + v.mediaLength;

    // Kernen: chunk-offsets er absolutte filpositioner og skal regnes om.
    const audioTrakStart = findAudioTrakStart(moov, audioId);
    patchTracks(moov, 8, audioTrakStart, v, videoMediaStart);
    patchTracks(moov, audioTrakStart, audioTrakStart + audioTrak.length, a, audioMediaStart);

    return [v.ftyp, moov, mdatHeader, ...v.media, ...a.media];
  }

  function findAudioTrakStart(moov, audioId) {
    for (const b of boxes(moov, 8, moov.length)) {
      if (b.type !== 'trak') continue;
      const tkhd = findDeep(moov, 'tkhd', b.start + b.headerSize, b.start + b.size);
      if (tkhd && u32(moov, tkhd.start + trackIdOffset(moov[tkhd.start + 8])) === audioId) {
        return b.start;
      }
    }
    throw new Error('kunne ikke finde lydsporet i det nye moov');
  }

  function patchTracks(moov, from, to, file, mediaStart) {
    let found = 0;
    for (const b of boxes(moov, from, to)) {
      if (b.type !== 'trak') continue;
      patchTrack(moov, b.start + b.headerSize, b.start + b.size, file, mediaStart);
      found++;
    }
    if (!found) throw new Error('fandt intet spor at rette offsets i');
  }

  function patchTrack(moov, from, to, file, mediaStart) {
    const stco = findDeep(moov, 'stco', from, to);
    if (stco) {
      const base = stco.start + stco.headerSize;
      const count = u32(moov, base + 4);
      for (let i = 0; i < count; i++) {
        const at = base + 8 + i * 4;
        setU32(moov, at, remap(file, u32(moov, at), mediaStart));
      }
      return;
    }
    const co64 = findDeep(moov, 'co64', from, to);
    if (!co64) throw new Error('sporet har hverken stco eller co64');
    const base = co64.start + co64.headerSize;
    const count = u32(moov, base + 4);
    for (let i = 0; i < count; i++) {
      const at = base + 8 + i * 8;
      setU64(moov, at, remap(file, u64(moov, at), mediaStart));
    }
  }

  function remap(file, off, mediaStart) {
    for (const r of file.ranges) {
      if (off >= r.from && off < r.to) return mediaStart + r.out + (off - r.from);
    }
    throw new Error('et chunk-offset peger uden for mediedata');
  }

  // ---- Indgang -------------------------------------------------------------

  MUX.mux = function mux(videoParts, audioParts) {
    const v = openFile(videoParts, 'videosporet');
    const a = openFile(audioParts, 'lydsporet');
    if (!!v.fragments !== !!a.fragments) {
      throw new Error('sporene har hver sin slags MP4 og kan ikke samles');
    }
    return v.fragments ? muxFragmented(v, a) : muxProgressive(v, a);
  };

  self.__wfMux = MUX;
})();
