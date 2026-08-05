// Tabeller.
//
// Moderne sider (Cisco U. m.fl.) bygger tabeller af div'er med CSS-grid eller
// ARIA-roller i stedet for <table>. Word ser kun en tabel hvis den ER en
// <table> – ellers lander rækkerne som løs tekst under hinanden. Her bygges de
// om til en rigtig tabel, og rigtige tabeller får synlige streger med, fordi
// sidens CSS ikke følger med i klippet.
(() => {
  const WF = window.__wf;
  if (!WF || !WF.def) return;

  WF.def('tables', (WF) => {
    const TABLE_STYLE = 'border-collapse:collapse;';
    const CELL_STYLE = 'border:1px solid #999;padding:4px 8px;vertical-align:top;';

    function buildTable(rows, headerFirst) {
      const table = document.createElement('table');
      table.setAttribute('border', '1');
      table.setAttribute('cellspacing', '0');
      table.setAttribute('cellpadding', '6');
      WF.util.setOwnStyle(table, TABLE_STYLE);
      rows.forEach((cells, i) => {
        const tr = document.createElement('tr');
        cells.forEach((cell) => {
          const head = i === 0 && headerFirst;
          const td = document.createElement(head ? 'th' : 'td');
          WF.util.setOwnStyle(td, CELL_STYLE + (head ? 'text-align:left;' : ''));
          while (cell.firstChild) td.appendChild(cell.firstChild);
          tr.appendChild(td);
        });
        table.appendChild(tr);
      });
      return table;
    }

    // Ser første række ud som overskrifter (fed skrift)?
    const boldRow = (liveRow) => {
      const first = liveRow && liveRow.firstElementChild;
      if (!first || !first.isConnected) return false;
      return parseInt(getComputedStyle(first).fontWeight) >= 600;
    };

    // En container med afkrydsninger er en quiz, ikke en tabel – hænderne væk.
    const isQuizish = (el) =>
      !!el.querySelector('input[type="radio"], input[type="checkbox"], [class*="rounded-full"]');

    // a) ARIA-roller: role="table"/"grid" med rækker og celler.
    function fromAria(root) {
      root.querySelectorAll('[role="table"], [role="grid"]').forEach((t) => {
        if (!t.isConnected && !root.contains(t)) return;
        const rowEls = [...t.querySelectorAll('[role="row"]')];
        if (rowEls.length < 2) return;
        const rows = rowEls.map((r) => [...r.querySelectorAll(
          '[role="cell"], [role="gridcell"], [role="columnheader"], [role="rowheader"]'
        )]);
        if (!rows.every((r) => r.length)) return;
        t.replaceWith(buildTable(rows, !!rowEls[0].querySelector('[role="columnheader"]')));
      });
    }

    // b) CSS-grid: N kolonner og et antal børn der går op i N.
    function fromGrid(root, liveOf) {
      root.querySelectorAll('div, section, ul, ol').forEach((el) => {
        if (!root.contains(el) || isQuizish(el)) return;
        const live = liveOf.get(el);
        if (!live || !live.isConnected) return;
        const cs = getComputedStyle(live);
        if (!cs.display.includes('grid')) return;
        const cols = (cs.gridTemplateColumns || '')
          .split(/\s+/).filter((x) => x && x !== 'none').length;
        if (cols < 2) return;
        const kids = [...el.children];
        if (kids.length < cols * 2 || kids.length % cols) return;
        const rows = [];
        for (let i = 0; i < kids.length; i += cols) rows.push(kids.slice(i, i + cols));
        el.replaceWith(buildTable(rows, boldRow(live)));
      });
    }

    // c) Rækker af div'er (flex m.m.): alle rækker har lige mange celler, og
    //    cellerne i en række står faktisk ved siden af hinanden på skærmen.
    //    Uden det sidste krav ville enhver liste af kort blive til en tabel.
    function fromRows(root, liveOf) {
      const sideBySide = (kids) => kids.every((k) => {
        const lk = liveOf.get(k);
        if (!lk || !lk.isConnected) return false;
        const rs = [...lk.children].map((c) => c.getBoundingClientRect());
        return rs.every((r) => Math.abs(r.top - rs[0].top) < 6) &&
          rs[rs.length - 1].right - rs[0].left > 150;
      });

      root.querySelectorAll('div, section').forEach((el) => {
        if (!root.contains(el) || isQuizish(el)) return;
        const kids = [...el.children];
        if (kids.length < 3) return;
        const cols = kids[0].children.length;
        if (cols < 2 || !kids.every((k) => k.children.length === cols)) return;
        const live = liveOf.get(el);
        if (!live || !live.isConnected) return;
        if (!sideBySide(kids)) return;
        el.replaceWith(buildTable(kids.map((k) => [...k.children]), boldRow(live)));
      });
    }

    // d) Rigtige <table>: sidens streger ligger i CSS'en og følger ikke med.
    function styleRealTables(root) {
      root.querySelectorAll('table').forEach((t) => {
        if (t.getAttribute('style') === TABLE_STYLE) return; // vores egen
        t.setAttribute('border', '1');
        t.setAttribute('cellspacing', '0');
        t.setAttribute('cellpadding', '6');
        WF.util.setOwnStyle(t, ((t.getAttribute('style') || '') + ';' + TABLE_STYLE).replace(/^;/, ''));
        t.querySelectorAll('td, th').forEach((c) => {
          WF.util.setOwnStyle(c, ((c.getAttribute('style') || '') + ';' + CELL_STYLE).replace(/^;/, ''));
        });
      });
    }

    function tablify(root, liveOf) {
      fromAria(root);
      if (liveOf) {
        fromGrid(root, liveOf);
        fromRows(root, liveOf);
      }
      styleRealTables(root);
    }

    WF.tables = { TABLE_STYLE, CELL_STYLE, buildTable, tablify };
  });
})();
