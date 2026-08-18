/* Chattahoochee Watch — tiny dependency-free SVG chart helpers */
(function (global) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const el = (n, a) => {
    const e = document.createElementNS(NS, n);
    for (const k in a) if (a[k] !== null && a[k] !== undefined) e.setAttribute(k, a[k]);
    return e;
  };
  const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  function niceStep(range, target) {
    if (!(range > 0)) return 1;
    const raw = range / (target || 5);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return step * mag;
  }

  function fmt(v, dp) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    if (dp !== undefined) return v.toFixed(dp);
    const a = Math.abs(v);
    if (a >= 1000) return Math.round(v).toLocaleString();
    if (a >= 100) return v.toFixed(0);
    if (a >= 10) return v.toFixed(1);
    return v.toFixed(2);
  }

  function mount(box, svg) {
    box.innerHTML = '';
    box.appendChild(svg);
  }

  function empty(box, msg) {
    box.innerHTML = '<div class="err">' + esc(msg || 'No data available right now.') + '</div>';
  }

  /* ---------------- time-series line chart ---------------- */
  /* series: [{name,color,points:[{t:Date|ms, v:Number}],dashed,axis}] */
  function lineChart(box, series, opts) {
    opts = opts || {};
    series = (series || []).filter(s => s && s.points && s.points.length);
    if (!series.length) return empty(box, opts.emptyMsg);

    const W = opts.width || 940, H = opts.height || 300;
    const padL = opts.padL || 54, padR = opts.padR || 14, padT = 16, padB = 34;
    const pw = W - padL - padR, ph = H - padT - padB;

    let tMin = Infinity, tMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    series.forEach(s => s.points.forEach(p => {
      const t = +p.t;
      if (!isFinite(t) || p.v === null || !isFinite(p.v)) return;
      if (t < tMin) tMin = t; if (t > tMax) tMax = t;
      if (p.v < vMin) vMin = p.v; if (p.v > vMax) vMax = p.v;
    }));
    if (!isFinite(tMin) || !isFinite(vMin)) return empty(box, opts.emptyMsg);

    if (opts.threshold !== undefined && opts.threshold !== null) {
      vMax = Math.max(vMax, opts.threshold * 1.05);
    }
    if (opts.includeZero) vMin = Math.min(vMin, 0);
    if (vMax === vMin) { vMax += 1; vMin -= 1; }
    const padV = (vMax - vMin) * 0.12;
    vMin -= padV; vMax += padV;
    if (opts.minZero && vMin < 0) vMin = 0;
    if (tMax === tMin) tMax = tMin + 1;

    const X = t => padL + ((+t - tMin) / (tMax - tMin)) * pw;
    const Y = v => padT + ph - ((v - vMin) / (vMax - vMin)) * ph;

    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', preserveAspectRatio: 'none' });

    // y grid
    const step = niceStep(vMax - vMin, 5);
    for (let g = Math.ceil(vMin / step) * step; g <= vMax; g += step) {
      svg.appendChild(el('line', { x1: padL, y1: Y(g).toFixed(1), x2: W - padR, y2: Y(g).toFixed(1), class: 'grid-l' }));
      const tx = el('text', { x: padL - 8, y: (Y(g) + 4).toFixed(1), class: 'ax', 'text-anchor': 'end' });
      tx.textContent = fmt(g, opts.yDp);
      svg.appendChild(tx);
    }

    // x labels
    const days = (tMax - tMin) / 86400000;
    const ticks = opts.xTicks || 6;
    for (let i = 0; i <= ticks; i++) {
      const t = tMin + (i / ticks) * (tMax - tMin);
      const d = new Date(t);
      let lbl;
      if (opts.xMode === 'datetime') {
        lbl = (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
          d.toLocaleTimeString([], { hour: 'numeric' }).replace(/\s?([AP])M/i, (m, p) => p.toLowerCase());
      } else {
        lbl = days > 2 ? (d.getMonth() + 1) + '/' + d.getDate()
          : d.toLocaleTimeString([], { hour: 'numeric' });
      }
      const tx = el('text', { x: X(t).toFixed(1), y: H - 12, class: 'ax', 'text-anchor': 'middle' });
      tx.textContent = lbl;
      svg.appendChild(tx);
    }

    // midnight markers, so a daily cycle is easy to line up
    if (opts.dayLines) {
      const d0 = new Date(tMin);
      d0.setHours(24, 0, 0, 0);
      for (let t = +d0; t <= tMax; t += 86400000) {
        svg.appendChild(el('line', {
          x1: X(t).toFixed(1), y1: padT, x2: X(t).toFixed(1), y2: (padT + ph).toFixed(1), class: 'daymark'
        }));
        const dl = el('text', { x: (X(t) + 5).toFixed(1), y: padT + 11, class: 'daylbl' });
        dl.textContent = new Date(t).toLocaleDateString([], { weekday: 'short' });
        svg.appendChild(dl);
      }
    }

    // threshold
    if (opts.threshold !== undefined && opts.threshold !== null && opts.threshold >= vMin && opts.threshold <= vMax) {
      svg.appendChild(el('line', { x1: padL, y1: Y(opts.threshold).toFixed(1), x2: W - padR, y2: Y(opts.threshold).toFixed(1), class: 'thresh' }));
      const tl = el('text', { x: W - padR - 4, y: (Y(opts.threshold) - 6).toFixed(1), class: 'threshlbl', 'text-anchor': 'end' });
      tl.textContent = opts.thresholdLabel || '';
      svg.appendChild(tl);
    }

    // series
    series.forEach(s => {
      const pts = s.points.filter(p => p.v !== null && isFinite(p.v) && isFinite(+p.t))
        .sort((a, b) => +a.t - +b.t);
      if (!pts.length) return;
      const d = pts.map((p, i) => (i ? 'L' : 'M') + X(p.t).toFixed(1) + ' ' + Y(p.v).toFixed(1)).join(' ');
      if (s.fill) {
        const area = d + ` L${X(pts[pts.length - 1].t).toFixed(1)} ${(padT + ph).toFixed(1)}` +
          ` L${X(pts[0].t).toFixed(1)} ${(padT + ph).toFixed(1)} Z`;
        svg.appendChild(el('path', { d: area, fill: s.color, class: 'area' }));
      }
      svg.appendChild(el('path', {
        d, class: 'line', stroke: s.color,
        'stroke-dasharray': s.dashed ? '6 5' : null
      }));
      const last = pts[pts.length - 1];
      const dot = el('circle', { cx: X(last.t).toFixed(1), cy: Y(last.v).toFixed(1), r: 4, fill: s.color, class: 'dot' });
      const ti = el('title');
      ti.textContent = `${s.name}: ${fmt(last.v, opts.yDp)}${opts.unit ? ' ' + opts.unit : ''} @ ${new Date(last.t).toLocaleString()}`;
      dot.appendChild(ti);
      svg.appendChild(dot);
    });

    mount(box, svg);
  }

  /* ---------------- grouped comparison bars (current vs avg + range) ---------------- */
  function barCompare(box, rows, k, opts) {
    opts = opts || {};
    const W = 960, H = opts.height || 310;
    const padL = 48, padR = 12, padT = 14, padB = 34;
    const pw = W - padL - padR, ph = H - padT - padB;

    let top = 0;
    rows.forEach(r => {
      [r[k.cur], r[k.avg], r[k.max]].forEach(v => { if (v !== null && isFinite(v) && v > top) top = v; });
    });
    if (!(top > 0)) return empty(box, opts.emptyMsg);
    top *= 1.12;

    const Y = v => padT + ph - (v / top) * ph;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', preserveAspectRatio: 'none' });

    const step = niceStep(top, 5);
    for (let g = 0; g <= top; g += step) {
      svg.appendChild(el('line', { x1: padL, y1: Y(g).toFixed(1), x2: W - padR, y2: Y(g).toFixed(1), class: 'grid-l' }));
      const tx = el('text', { x: padL - 8, y: (Y(g) + 4).toFixed(1), class: 'ax', 'text-anchor': 'end' });
      tx.textContent = fmt(g, opts.yDp);
      svg.appendChild(tx);
    }

    const bw = pw / rows.length;
    rows.forEach((r, i) => {
      const x0 = padL + i * bw, cx = x0 + bw / 2;
      if (r[k.min] !== null && isFinite(r[k.min]) && r[k.max] !== null && isFinite(r[k.max])) {
        svg.appendChild(el('line', { x1: cx.toFixed(1), y1: Y(r[k.min]).toFixed(1), x2: cx.toFixed(1), y2: Y(r[k.max]).toFixed(1), class: 'whisk' }));
        [r[k.min], r[k.max]].forEach(v => svg.appendChild(el('line', {
          x1: (cx - 9).toFixed(1), y1: Y(v).toFixed(1), x2: (cx + 9).toFixed(1), y2: Y(v).toFixed(1), class: 'whisk'
        })));
      }
      const bar = (v, off, cls, label) => {
        if (v === null || !isFinite(v)) return;
        const rect = el('rect', {
          x: (x0 + bw * off).toFixed(1), y: Y(v).toFixed(1),
          width: (bw * 0.30).toFixed(1), height: Math.max(0, padT + ph - Y(v)).toFixed(1),
          class: cls, rx: 3
        });
        const t = el('title'); t.textContent = label; rect.appendChild(t);
        svg.appendChild(rect);
      };
      bar(r[k.avg], 0.16, 'bavg', `${r.name} average: ${fmt(r[k.avg], opts.yDp)} ${opts.unit || ''}`);
      bar(r[k.cur], 0.52, r.partial ? 'bcur partial' : 'bcur',
        `${r.name} ${opts.curLabel || 'current'}: ${fmt(r[k.cur], opts.yDp)} ${opts.unit || ''}${r.partial ? ' (partial month)' : ''}`);
      const tx = el('text', { x: cx.toFixed(1), y: H - 12, class: 'ax', 'text-anchor': 'middle' });
      tx.textContent = r.name;
      svg.appendChild(tx);
    });
    mount(box, svg);
  }

  /* ---------------- one bar per year, with average line ---------------- */
  function barYears(box, items, opts) {
    opts = opts || {};
    if (!items || !items.length) return empty(box, opts.emptyMsg);
    const W = 960, H = opts.height || 250;
    const padL = 48, padR = 12, padT = 18, padB = 34;
    const pw = W - padL - padR, ph = H - padT - padB;
    const top = Math.max.apply(null, items.map(i => i.value)) * 1.16 || 1;
    const Y = v => padT + ph - (v / top) * ph;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', preserveAspectRatio: 'none' });
    const bw = pw / items.length;

    items.forEach((it, i) => {
      const x0 = padL + i * bw;
      const rect = el('rect', {
        x: (x0 + bw * 0.18).toFixed(1), y: Y(it.value).toFixed(1),
        width: (bw * 0.64).toFixed(1), height: Math.max(0, padT + ph - Y(it.value)).toFixed(1),
        class: it.highlight ? 'bcur' : 'bhist', rx: 4
      });
      const t = el('title'); t.textContent = `${it.label}: ${fmt(it.value, opts.yDp)} ${opts.unit || ''}`;
      rect.appendChild(t); svg.appendChild(rect);
      const vt = el('text', { x: (x0 + bw / 2).toFixed(1), y: (Y(it.value) - 6).toFixed(1), class: 'val', 'text-anchor': 'middle' });
      vt.textContent = fmt(it.value, opts.yDp);
      svg.appendChild(vt);
      const lt = el('text', { x: (x0 + bw / 2).toFixed(1), y: H - 12, class: 'ax', 'text-anchor': 'middle' });
      lt.textContent = it.label;
      svg.appendChild(lt);
    });

    if (opts.avg !== undefined && opts.avg !== null) {
      svg.appendChild(el('line', { x1: padL, y1: Y(opts.avg).toFixed(1), x2: W - padR, y2: Y(opts.avg).toFixed(1), class: 'avgline' }));
      const lb = el('text', { x: W - padR - 4, y: (Y(opts.avg) - 6).toFixed(1), class: 'avglbl', 'text-anchor': 'end' });
      lb.textContent = opts.avgLabel || ('average ' + fmt(opts.avg, opts.yDp));
      svg.appendChild(lb);
    }
    mount(box, svg);
  }

  /* ---------------- simple vertical bars (forecast rain) ---------------- */
  function barSimple(box, items, opts) {
    opts = opts || {};
    if (!items || !items.length) return empty(box, opts.emptyMsg);
    const W = 620, H = opts.height || 240;
    const padL = 44, padR = 12, padT = 18, padB = 40;
    const pw = W - padL - padR, ph = H - padT - padB;
    const top = Math.max(Math.max.apply(null, items.map(i => i.value)), opts.minTop || 0.25) * 1.2;
    const Y = v => padT + ph - (v / top) * ph;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', preserveAspectRatio: 'none' });
    const step = niceStep(top, 4);
    for (let g = 0; g <= top; g += step) {
      svg.appendChild(el('line', { x1: padL, y1: Y(g).toFixed(1), x2: W - padR, y2: Y(g).toFixed(1), class: 'grid-l' }));
      const tx = el('text', { x: padL - 8, y: (Y(g) + 4).toFixed(1), class: 'ax', 'text-anchor': 'end' });
      tx.textContent = fmt(g, opts.yDp);
      svg.appendChild(tx);
    }
    const bw = pw / items.length;
    items.forEach((it, i) => {
      const x0 = padL + i * bw;
      const rect = el('rect', {
        x: (x0 + bw * 0.22).toFixed(1), y: Y(it.value).toFixed(1),
        width: (bw * 0.56).toFixed(1), height: Math.max(1, padT + ph - Y(it.value)).toFixed(1),
        class: 'bcur', rx: 3, opacity: it.opacity || 1
      });
      const t = el('title'); t.textContent = it.title || `${it.label}: ${fmt(it.value, opts.yDp)} ${opts.unit || ''}`;
      rect.appendChild(t); svg.appendChild(rect);
      if (it.value > 0) {
        const vt = el('text', { x: (x0 + bw / 2).toFixed(1), y: (Y(it.value) - 5).toFixed(1), class: 'val', 'text-anchor': 'middle' });
        vt.textContent = fmt(it.value, opts.yDp);
        svg.appendChild(vt);
      }
      const lt = el('text', { x: (x0 + bw / 2).toFixed(1), y: H - 20, class: 'ax', 'text-anchor': 'middle' });
      lt.textContent = it.label;
      svg.appendChild(lt);
      if (it.sub) {
        const st = el('text', { x: (x0 + bw / 2).toFixed(1), y: H - 6, class: 'ax', 'text-anchor': 'middle' });
        st.textContent = it.sub;
        svg.appendChild(st);
      }
    });
    mount(box, svg);
  }

  /* ---------------- grouped bar chart ----------------
     groups: [{label, sub}]                      one per x-axis slot
     series: [{name, color, values:[Number|null]}]  one value per group
  */
  function barGroups(box, groups, series, opts) {
    opts = opts || {};
    series = (series || []).filter(s => s && s.values && s.values.length);
    if (!groups || !groups.length || !series.length) return empty(box, opts.emptyMsg);

    const W = opts.width || 960, H = opts.height || 320;
    const padL = 58, padR = 12, padT = 16, padB = 42;
    const pw = W - padL - padR, ph = H - padT - padB;

    let top = 0;
    series.forEach(s => s.values.forEach(v => { if (v !== null && isFinite(v) && v > top) top = v; }));
    if (!(top > 0)) return empty(box, opts.emptyMsg);
    const step = niceStep(top, 5);
    top = Math.ceil(top / step) * step;
    const Y = v => padT + ph - (v / top) * ph;

    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', preserveAspectRatio: 'none' });

    for (let g = 0; g <= top + 1e-9; g += step) {
      const y = Y(g).toFixed(1);
      svg.appendChild(el('line', { x1: padL, y1: y, x2: W - padR, y2: y, class: 'grid' }));
      const t = el('text', { x: padL - 8, y: (+y + 4).toFixed(1), class: 'ax', 'text-anchor': 'end' });
      t.textContent = fmt(g, opts.yDp);
      svg.appendChild(t);
    }

    const slot = pw / groups.length;
    const inner = slot * 0.78;
    const bw = Math.max(2, inner / series.length - 1.5);

    groups.forEach((grp, gi) => {
      const x0 = padL + gi * slot + (slot - inner) / 2;
      series.forEach((s, si) => {
        const v = s.values[gi];
        if (v === null || !isFinite(v)) return;
        const y = Y(v), h = Math.max(1, padT + ph - y);
        const bx = x0 + si * (inner / series.length);
        const r = el('rect', { x: bx.toFixed(1), y: y.toFixed(1), width: bw.toFixed(1),
          height: h.toFixed(1), fill: s.color, rx: 2 });
        const ti = el('title');
        ti.textContent = `${s.name} — ${grp.label}: ${fmt(v, opts.yDp)}${opts.unit ? ' ' + opts.unit : ''}`;
        r.appendChild(ti);
        svg.appendChild(r);
      });
      const lt = el('text', { x: (x0 + inner / 2).toFixed(1), y: H - 22, class: 'ax', 'text-anchor': 'middle' });
      lt.textContent = grp.label;
      svg.appendChild(lt);
      if (grp.sub) {
        const st = el('text', { x: (x0 + inner / 2).toFixed(1), y: H - 8, class: 'ax', 'text-anchor': 'middle' });
        st.textContent = grp.sub;
        svg.appendChild(st);
      }
    });

    svg.appendChild(el('line', { x1: padL, y1: (padT + ph).toFixed(1), x2: W - padR,
      y2: (padT + ph).toFixed(1), class: 'axis' }));
    mount(box, svg);
  }

  global.Charts = { lineChart, barCompare, barYears, barSimple, barGroups, fmt, empty };
})(window);
