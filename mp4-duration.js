// Varigheder i en fragmenteret MP4.
//
// mux.js skriver 0xFFFFFFFF – "ukendt" – i mvhd, tkhd og mdhd. Det er rigtigt
// for den brug biblioteket er lavet til: afspilning i browseren gennem MSE,
// hvor JavaScript fortæller afspilleren hvor lang strømmen er, og filen aldrig
// skal stå alene. En fil på disken har ingen til at fortælle det. Så skal
// varigheden stå i filen selv, ellers har afspilleren intet at styre efter.
//
// Afspillere håndterer det forskelligt: nogle læser hele filen igennem og
// regner varigheden ud selv, andre tror på det der står. De sidste får en
// søgelinje på mange timer og en afspilning der ikke opfører sig.
//
// Her lægges de rigtige tal ind: varigheden pr. spor er summen af
// sample-varighederne i fragmenterne, og den skrives ind i init-segmentet.
// Kan vi ikke regne den ud, rører vi ikke filen – et forkert tal er værre end
// et der er mærket ukendt.
(() => {
  // ---- Bokse ---------------------------------------------------------------

  // Kald `fn` for hver boks mellem `start` og `end`. `body` er første byte
  // efter boks-hovedet, `end` første byte efter boksen.
  function boxes(u8, dv, start, end, fn) {
    let o = start;
    while (o + 8 <= end) {
      let size = dv.getUint32(o);
      const type = String.fromCharCode(u8[o + 4], u8[o + 5], u8[o + 6], u8[o + 7]);
      let head = 8;
      if (size === 1) { size = Number(dv.getBigUint64(o + 8)); head = 16; }
      else if (size === 0) size = end - o;
      if (size < head || o + size > end) return;   // beskadiget – stop her
      fn(type, o, o + head, o + size);
      o += size;
    }
  }

  const view = (part) => {
    const u8 = part instanceof Uint8Array ? part : new Uint8Array(part);
    return [u8, new DataView(u8.buffer, u8.byteOffset, u8.byteLength)];
  };

  // ---- Hvor lang er hvert spor? -------------------------------------------

  // Summen af sample-varighederne i alle fragmenter, spor for spor. Tallet er
  // i sporets egen tidsskala (mdhd timescale).
  function trackDurations(parts) {
    const total = Object.create(null);

    for (const part of parts) {
      const [u8, dv] = view(part);
      boxes(u8, dv, 0, u8.length, (type, box, body, end) => {
        if (type !== 'moof') return;
        boxes(u8, dv, body, end, (t2, box2, body2, end2) => {
          if (t2 !== 'traf') return;
          let trackId = 0, defaultDur = 0, sum = 0, sawTrun = false;

          boxes(u8, dv, body2, end2, (t3, box3, body3) => {
            if (t3 === 'tfhd') {
              const flags = dv.getUint32(body3) & 0xffffff;
              trackId = dv.getUint32(body3 + 4);
              let p = body3 + 8;
              if (flags & 0x01) p += 8;            // base_data_offset
              if (flags & 0x02) p += 4;            // sample_description_index
              if (flags & 0x08) defaultDur = dv.getUint32(p);
              return;
            }
            if (t3 !== 'trun') return;
            sawTrun = true;
            const flags = dv.getUint32(body3) & 0xffffff;
            const count = dv.getUint32(body3 + 4);
            let p = body3 + 8;
            if (flags & 0x0001) p += 4;            // data_offset
            if (flags & 0x0004) p += 4;            // first_sample_flags
            if (flags & 0x0100) {
              // Varighed pr. sample – spring de øvrige felter i posten over.
              const stride = 4 + ((flags & 0x0200) ? 4 : 0) +
                ((flags & 0x0400) ? 4 : 0) + ((flags & 0x0800) ? 4 : 0);
              for (let i = 0; i < count; i++) sum += dv.getUint32(p + i * stride);
            } else {
              sum += count * defaultDur;           // fælles varighed fra tfhd
            }
          });

          if (sawTrun && trackId) total[trackId] = (total[trackId] || 0) + sum;
        });
      });
    }
    return total;
  }

  // ---- Skriv tallene ind ---------------------------------------------------

  // Felternes placering afhænger af boksens version: version 1 bruger 64 bit
  // til tidspunkter og varighed, version 0 bruger 32.
  const at = (body, v, v0, v1) => body + (v === 1 ? v1 : v0);

  function writeDur(dv, u8, body, offs0, offs1, value) {
    const v = u8[body];
    const p = at(body, v, offs0, offs1);
    if (v === 1) dv.setBigUint64(p, BigInt(Math.round(value)));
    // 0xFFFFFFFF betyder "ukendt" – hold os under, så tallet ikke læses sådan.
    else dv.setUint32(p, Math.min(Math.round(value), 0xfffffffe));
  }

  function stampInit(part, totals) {
    const [u8, dv] = view(part);
    let movieTs = 0;
    let mvhd = -1;
    let mehd = -1;
    const traks = [];

    boxes(u8, dv, 0, u8.length, (type, box, body, end) => {
      if (type !== 'moov') return;
      boxes(u8, dv, body, end, (t2, box2, body2, end2) => {
        if (t2 === 'mvhd') {
          movieTs = dv.getUint32(at(body2, u8[body2], 12, 20));
          mvhd = body2;
          return;
        }
        if (t2 === 'mvex') {
          boxes(u8, dv, body2, end2, (t3, box3, body3) => {
            if (t3 === 'mehd') mehd = body3;
          });
          return;
        }
        if (t2 !== 'trak') return;
        let tkhd = -1, mdhd = -1, id = 0, mediaTs = 0;
        boxes(u8, dv, body2, end2, (t3, box3, body3, end3) => {
          if (t3 === 'tkhd') {
            id = dv.getUint32(at(body3, u8[body3], 12, 20));
            tkhd = body3;
            return;
          }
          if (t3 !== 'mdia') return;
          boxes(u8, dv, body3, end3, (t4, box4, body4) => {
            if (t4 !== 'mdhd') return;
            mediaTs = dv.getUint32(at(body4, u8[body4], 12, 20));
            mdhd = body4;
          });
        });
        if (tkhd >= 0 && mdhd >= 0 && id && mediaTs) {
          traks.push({ id, mediaTs, tkhd, mdhd });
        }
      });
    });

    if (mvhd < 0 || !movieTs || !traks.length) return false;

    let longest = 0;
    let stamped = 0;
    for (const t of traks) {
      const ticks = totals[t.id];
      if (!ticks) continue;                        // ukendt spor – lad det stå
      writeDur(dv, u8, t.mdhd, 16, 24, ticks);
      const inMovie = ticks / t.mediaTs * movieTs;
      writeDur(dv, u8, t.tkhd, 20, 28, inMovie);
      if (inMovie > longest) longest = inMovie;
      stamped++;
    }
    if (!stamped) return false;

    // Filmens varighed er det længste spor.
    writeDur(dv, u8, mvhd, 16, 24, longest);

    // mehd siger det samme om en fragmenteret film, og nogle afspillere tror
    // på den frem for mvhd. Vores egen muxer kopierer mvex – og dermed mehd –
    // uændret fra videosporet, så stod der videoens længde, også når lyden var
    // den længste af de to. Her får den det rigtige tal med.
    if (mehd >= 0) writeDur(dv, u8, mehd, 4, 4, longest);
    return true;
  }

  // Skriv varighederne ind i `parts`. Returnerer true hvis der blev rettet
  // noget.
  //
  // moov'en ligger ikke nødvendigvis i den første stump: mux.js lægger ftyp og
  // moov samlet i ét init-segment, mens vores egen muxer leverer dem som hver
  // sin. Så vi leder efter den i stedet for at regne med hvor den er – ellers
  // står varighederne stille som "ukendt", uden at nogen får det at vide.
  function stamp(parts) {
    if (!parts || !parts.length) return false;
    const totals = trackDurations(parts);
    if (!Object.keys(totals).length) return false;
    for (const part of parts) {
      if (stampInit(part, totals)) return true;
    }
    return false;
  }

  self.__wfDuration = { stamp, trackDurations };
})();
