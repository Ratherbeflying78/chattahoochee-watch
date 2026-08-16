/* ===========================================================================
   Chattahoochee Watch — live data application
   All data is fetched client-side from public, keyless, CORS-enabled APIs.
   =========================================================================== */
(function () {
  'use strict';

  const $ = s => document.querySelector(s);
  const $$ = s => Array.prototype.slice.call(document.querySelectorAll(s));
  const F = Charts.fmt;

  /* ---------------------------------------------------------------- config */
  const USGS_IV = 'https://waterservices.usgs.gov/nwis/iv/';
  const LAGRANGE = { lat: 33.0362, lon: -85.0313 };

  // Ordered downstream: Lanier -> Buford -> Atlanta -> West Point
  const STATIONS = [
    { id: '02334400', name: 'Lake Sidney Lanier', sub: 'near Buford — headwater reservoir', type: 'lake', lat: 34.16272, lon: -84.07553 },
    { id: '02334430', name: 'Buford Dam', sub: 'Chattahoochee R. at Buford Dam', type: 'river', lat: 34.15667, lon: -84.07842 },
    { id: '02335000', name: 'Norcross', sub: 'Chattahoochee R. near Norcross', type: 'river', lat: 33.99722, lon: -84.20194 },
    { id: '02335450', name: 'Above Roswell', sub: 'Chattahoochee R. above Roswell', type: 'river', lat: 33.98581, lon: -84.31569 },
    { id: '02335815', name: 'Morgan Falls Dam', sub: 'below Morgan Falls Dam', type: 'river', lat: 33.96775, lon: -84.38367 },
    { id: '02336000', name: 'Atlanta', sub: 'Chattahoochee R. at Atlanta (US 41)', type: 'river', lat: 33.85917, lon: -84.45444 },
    { id: '02336490', name: 'GA 280 near Atlanta', sub: 'below Peachtree Creek', type: 'river', lat: 33.81742, lon: -84.48033 },
    { id: '02337170', name: 'Fairburn', sub: 'Chattahoochee R. near Fairburn', type: 'river', lat: 33.65667, lon: -84.67361 },
    { id: '02338000', name: 'Whitesburg', sub: 'Chattahoochee R. near Whitesburg', type: 'river', lat: 33.47653, lon: -84.90119 },
    { id: '02338500', name: 'Franklin', sub: 'Chattahoochee R. at GA 100 — lake inflow', type: 'river', lat: 33.27797, lon: -85.10092 },
    { id: '02339400', name: 'West Point Lake', sub: 'reservoir pool near West Point', type: 'lake', lat: 32.91825, lon: -85.18775 },
    { id: '02339402', name: 'Below West Point Dam', sub: 'tailwater stage', type: 'river', lat: 32.91819, lon: -85.18786 },
    { id: '02339500', name: 'West Point', sub: 'Chattahoochee R. at West Point', type: 'river', lat: 32.88664, lon: -85.18158 }
  ];

  const PLACES = [
    { name: 'Buford', lat: 34.1206, lon: -84.0044 },
    { name: 'Roswell', lat: 34.0232, lon: -84.3616 },
    { name: 'Atlanta', lat: 33.7490, lon: -84.3880 },
    { name: 'Douglasville', lat: 33.7515, lon: -84.7477 },
    { name: 'Newnan', lat: 33.3807, lon: -84.7997 },
    { name: 'Carrollton', lat: 33.5801, lon: -85.0766 },
    { name: 'LaGrange', lat: 33.0362, lon: -85.0313 },
    { name: 'West Point', lat: 32.8779, lon: -85.1830 }
  ];
  const SITE = Object.fromEntries(STATIONS.map(s => [s.id, s]));
  const SITE_IDS = STATIONS.map(s => s.id).join(',');

  const P = {
    flow: '00060', stage: '00065', wtemp: '00010', elev: '00062', storage: '72036',
    do: '00300', ph: '00400', spc: '00095', turb: '63680', ecoli: '99407',
    precip: '00045', atemp: '00020', wind: '00035', windDir: '00036', rh: '00052', baro: '00025'
  };

  // Approximate USACE guide curve for West Point Lake (ft, project datum).
  // Reconstructed for reference only — see footer caveat.
  const WP = {
    full: 635, winter: 628, floodTop: 641, min: 622,
    curve: [[1, 628], [60, 628], [91, 632.5], [105, 635], [121, 635], [244, 635],
            [274, 633], [305, 630], [335, 628], [366, 628]]
  };
  const LANIER_FULL = 1071;
  const ECOLI_THRESHOLD = 235;   // cfu/100 mL, single-sample contact-recreation guideline
  const DO_MIN = 5.0;            // mg/L, Georgia warm-water stream standard

  function guideCurve(date) {
    const start = new Date(date.getFullYear(), 0, 0);
    const doy = Math.floor((date - start) / 86400000);
    const c = WP.curve;
    for (let i = 0; i < c.length - 1; i++) {
      if (doy >= c[i][0] && doy <= c[i + 1][0]) {
        const f = (doy - c[i][0]) / (c[i + 1][0] - c[i][0]);
        return c[i][1] + f * (c[i + 1][1] - c[i][1]);
      }
    }
    return WP.winter;
  }

  /* ------------------------------------------------------------- utilities */
  function fetchJSON(url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 25000);
    return fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } })
      .then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + url);
        return r.json();
      })
      .finally(() => clearTimeout(timer));
  }

  const num = v => {
    const n = parseFloat(v);
    return isFinite(n) && n > -999998 ? n : null;
  };
  const cToF = c => (c === null ? null : c * 9 / 5 + 32);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const err = (sel, msg) => { const e = $(sel); if (e) e.innerHTML = '<div class="err">' + esc(msg) + '</div>'; };

  function ago(d) {
    if (!d) return '';
    const m = Math.round((Date.now() - +d) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    if (h < 24) return h + ' hr ago';
    return Math.round(h / 24) + ' d ago';
  }

  function trend(pts, hours) {
    if (!pts || pts.length < 2) return null;
    const last = pts[pts.length - 1];
    const cutoff = +last.t - (hours || 24) * 3600000;
    let ref = null;
    for (let i = pts.length - 1; i >= 0; i--) { if (+pts[i].t <= cutoff) { ref = pts[i]; break; } }
    if (!ref) ref = pts[0];
    return last.v - ref.v;
  }

  function arrow(d, dp, unit) {
    if (d === null || !isFinite(d)) return '<span class="na">—</span>';
    const eps = Math.pow(10, -(dp === undefined ? 2 : dp)) * 5;
    if (Math.abs(d) < eps) return '<span class="flat">steady</span>';
    const cls = d > 0 ? 'up' : 'down';
    return `<span class="${cls}">${d > 0 ? '▲' : '▼'} ${F(Math.abs(d), dp)}${unit ? ' ' + unit : ''}</span>`;
  }

  /* -------------------------------------------------------- USGS ingestion */
  const DATA = { sites: {}, wx: null, rain: null, fetchedAt: null };

  function parseIV(json) {
    const out = {};
    const ts = (json && json.value && json.value.timeSeries) || [];
    ts.forEach(s => {
      const site = s.sourceInfo.siteCode[0].value;
      const code = s.variable.variableCode[0].value;
      const vals = (s.values && s.values[0] && s.values[0].value) || [];
      const points = vals.map(v => ({ t: new Date(v.dateTime), v: num(v.value) }))
        .filter(p => p.v !== null && !isNaN(+p.t));
      if (!points.length) return;
      const rec = {
        points,
        latest: points[points.length - 1].v,
        at: points[points.length - 1].t,
        unit: s.variable.unit.unitCode,
        name: s.variable.variableName.split(',')[0]
      };
      (out[site] = out[site] || {})[code] = rec;
    });
    return out;
  }

  function loadWater() {
    const url = `${USGS_IV}?format=json&sites=${SITE_IDS}&period=P14D&siteStatus=all`;
    return fetchJSON(url, 40000).then(j => { DATA.sites = parseIV(j); return DATA.sites; });
  }

  const get = (site, code) => (DATA.sites[site] || {})[code] || null;
  const val = (site, code) => { const r = get(site, code); return r ? r.latest : null; };

  /* =====================================================================
     PANEL 1 — LAKE NOW
     ===================================================================== */
  function renderLake() {
    const elev = get('02339400', P.elev);
    if (!elev) return err('#lakeHero', 'West Point Lake elevation is not reporting right now.');

    const lvl = elev.latest;
    const target = guideCurve(new Date());
    const diff = lvl - target;
    const d24 = trend(elev.points, 24);
    const d7 = trend(elev.points, 168);

    let cls, label, blurb;
    if (Math.abs(diff) <= 0.5) { cls = 'good'; label = 'Right on target'; blurb = 'sitting essentially at the seasonal guide curve'; }
    else if (diff > 3) { cls = 'warn'; label = 'Well above guide'; blurb = 'running high — the Corps is likely passing inflow through'; }
    else if (diff > 0.5) { cls = 'good'; label = 'Slightly high'; blurb = 'a little above the seasonal target'; }
    else if (diff > -3) { cls = 'warn'; label = 'Below guide'; blurb = 'drawn down below the seasonal target'; }
    else { cls = 'bad'; label = 'Well below guide'; blurb = 'substantially below the seasonal target — expect exposed ramps and shoals'; }

    const span = WP.floodTop - WP.min;
    const pct = Math.max(0, Math.min(100, ((lvl - WP.min) / span) * 100));

    $('#lakeHero').innerHTML = `
      <span class="badge ${cls}">${esc(label)}</span>
      <div class="eyebrow" style="margin-top:14px">West Point Lake pool elevation</div>
      <div class="lvl">${F(lvl, 2)}<small>ft</small></div>
      <p class="sub">That is <b>${diff >= 0 ? '+' : ''}${F(diff, 2)} ft</b> versus the approximate seasonal guide curve of
        <b>${F(target, 1)} ft</b> — ${blurb}.
        Over the last 24 hours the pool ${d24 === null ? 'has not moved measurably' :
          (Math.abs(d24) < 0.02 ? 'held steady' : (d24 > 0 ? 'rose <b>' + F(d24, 2) + ' ft</b>' : 'fell <b>' + F(Math.abs(d24), 2) + ' ft</b>'))}.
        Reading taken ${esc(ago(elev.at))}.</p>
      <div class="gauge">
        <div class="gaugebar"><div class="gaugefill" style="width:${pct.toFixed(1)}%"></div></div>
        <div class="gaugemarks">
          <span>${WP.min} min</span><span>${WP.winter} winter</span>
          <span>${WP.full} summer full</span><span>${WP.floodTop} flood top</span>
        </div>
      </div>`;

    const stor = get('02339400', P.storage);
    const outflow = val('02339500', P.flow);
    const inflow = val('02338500', P.flow);

    const kpis = [
      { lbl: 'Change, 24 hours', big: (d24 === null ? '—' : (d24 >= 0 ? '+' : '') + F(d24, 2) + ' ft'), note: 'pool elevation', cls: '' },
      { lbl: 'Change, 7 days', big: (d7 === null ? '—' : (d7 >= 0 ? '+' : '') + F(d7, 2) + ' ft'), note: 'pool elevation', cls: '' },
      { lbl: 'Storage', big: stor ? F(stor.latest, 0) + ' kaf' : '—', note: 'thousand acre-feet', cls: '' },
      { lbl: 'Inflow at Franklin', big: inflow !== null ? F(inflow, 0) : '—', note: 'cubic feet per second', cls: '' },
      { lbl: 'Outflow at West Point', big: outflow !== null ? F(outflow, 0) : '—', note: 'cubic feet per second', cls: '' }
    ];
    $('#lakeKpis').innerHTML = kpis.map(k =>
      `<div class="kpi ${k.cls}"><div class="lbl">${esc(k.lbl)}</div>
       <div class="big">${esc(k.big)}</div><div class="note">${esc(k.note)}</div></div>`).join('');

    // elevation chart with guide curve
    const guidePts = elev.points.map(p => ({ t: p.t, v: guideCurve(new Date(p.t)) }));
    Charts.lineChart($('#lakeChart'), [
      { name: 'Guide curve (approx.)', color: '#fbbf24', points: guidePts, dashed: true },
      { name: 'Pool elevation', color: '#38bdf8', points: elev.points, fill: true }
    ], { yDp: 1, unit: 'ft', height: 300 });

    // water budget
    if (inflow !== null && outflow !== null) {
      const net = inflow - outflow;
      const cfsToAfDay = 1.98347;
      $('#budget').innerHTML = `
        <table>
          <tr><td class="name">Inflow — Franklin</td><td>${F(inflow, 0)} cfs</td></tr>
          <tr><td class="name">Outflow — below dam</td><td>${F(outflow, 0)} cfs</td></tr>
          <tr class="hl"><td class="name">Net balance</td>
            <td class="${net > 0 ? 'up' : 'down'}">${net >= 0 ? '+' : ''}${F(net, 0)} cfs</td></tr>
          <tr><td class="name dim">Equivalent daily volume</td>
            <td class="dim">${net >= 0 ? '+' : ''}${F(net * cfsToAfDay, 0)} acre-ft/day</td></tr>
        </table>
        <p class="cap" style="margin-top:12px">${net > 0
          ? 'More water is arriving than leaving, so the pool should be rising.'
          : 'More water is leaving than arriving, so the pool should be falling.'}
          Franklin measures only the mainstem — tributaries like Yellowjacket Creek add ungauged inflow.</p>`;
    } else {
      $('#budget').innerHTML = '<div class="err">Inflow or outflow gauge is not reporting.</div>';
    }

    // Lanier
    const lel = get('02334400', P.elev), lst = get('02334400', P.storage);
    if (lel) {
      const ldiff = lel.latest - LANIER_FULL;
      $('#lanier').innerHTML = `
        <table>
          <tr><td class="name">Pool elevation</td><td>${F(lel.latest, 2)} ft</td></tr>
          <tr><td class="name">Versus full pool (${LANIER_FULL} ft)</td>
              <td class="${ldiff >= 0 ? 'up' : 'down'}">${ldiff >= 0 ? '+' : ''}${F(ldiff, 2)} ft</td></tr>
          ${lst ? `<tr><td class="name">Storage</td><td>${F(lst.latest, 0)} kaf</td></tr>` : ''}
          <tr><td class="name">Buford Dam release</td><td>${val('02334430', P.flow) !== null ? F(val('02334430', P.flow), 0) + ' cfs' : '—'}</td></tr>
          <tr><td class="name">24-hour change</td><td>${arrow(trend(lel.points, 24), 2, 'ft')}</td></tr>
        </table>
        <p class="cap" style="margin-top:12px">Lanier holds roughly ${lst ? F(lst.latest, 0) : '—'} thousand acre-feet.
          Releases from Buford Dam take several days to work downstream to West Point.</p>`;
    } else {
      $('#lanier').innerHTML = '<div class="err">Lanier gauge is not reporting.</div>';
    }
  }

  /* =====================================================================
     PANEL 2 — RIVER PROFILE
     ===================================================================== */
  /* =====================================================================
     RIVER MAP
     ===================================================================== */
  let GEO = null, MAP_METRIC = 'flow', MAP_SEL = null;

  function loadGeo() {
    if (GEO) return Promise.resolve(GEO);
    return fetchJSON('data/geo.json', 25000).then(g => { GEO = g; return g; });
  }

  const METRICS = {
    flow:    { label: 'Streamflow', unit: 'cfs', dp: 0 },
    level:   { label: 'Stage / pool', unit: 'ft', dp: 2 },
    temp:    { label: 'Water temperature', unit: '°F', dp: 1 },
    quality: { label: 'Water quality', unit: '', dp: 1 }
  };

  // Value for a station under the active metric.
  function metricValue(st, metric) {
    if (metric === 'flow') {
      const v = val(st.id, P.flow);
      return v === null ? null : { v, txt: F(v, 0) + ' cfs' };
    }
    if (metric === 'level') {
      if (st.type === 'lake') {
        const v = val(st.id, P.elev);
        return v === null ? null : { v, txt: F(v, 2) + ' ft' };
      }
      const v = val(st.id, P.stage);
      return v === null ? null : { v, txt: F(v, 2) + ' ft' };
    }
    if (metric === 'temp') {
      const c = val(st.id, P.wtemp);
      return c === null ? null : { v: cToF(c), txt: F(cToF(c), 1) + '°F' };
    }
    // quality: prefer bacteria, then DO, then turbidity
    const ec = val(st.id, P.ecoli);
    if (ec !== null) return { v: ec, txt: F(ec, 0) + ' cfu', kind: 'ecoli' };
    const dox = val(st.id, P.do);
    if (dox !== null) return { v: dox, txt: F(dox, 1) + ' mg/L', kind: 'do' };
    const tb = val(st.id, P.turb);
    if (tb !== null) return { v: tb, txt: F(tb, 1) + ' FNU', kind: 'turb' };
    return null;
  }

  function metricColor(st, metric, m) {
    if (!m) return '#3d4d6d';
    if (metric === 'quality') {
      if (m.kind === 'ecoli') return m.v >= ECOLI_THRESHOLD ? '#f87171'
        : m.v >= ECOLI_THRESHOLD / 2 ? '#fbbf24' : '#4ade80';
      if (m.kind === 'do') return m.v < DO_MIN ? '#f87171' : m.v < DO_MIN + 1 ? '#fbbf24' : '#4ade80';
      return m.v >= 50 ? '#f87171' : m.v >= 15 ? '#fbbf24' : '#4ade80';
    }
    if (metric === 'temp') {
      const t = Math.max(0, Math.min(1, (m.v - 45) / 40));      // 45°F -> 85°F
      const r = Math.round(56 + t * 190), g = Math.round(160 - t * 90), b = Math.round(230 - t * 150);
      return `rgb(${r},${g},${b})`;
    }
    if (metric === 'flow') {
      const t = Math.max(0, Math.min(1, Math.log10(Math.max(m.v, 1)) / 4.2));
      const r = Math.round(120 - t * 96), g = Math.round(200 - t * 60), b = Math.round(255 - t * 40);
      return `rgb(${r},${g},${b})`;
    }
    return '#38bdf8';
  }

  function metricRadius(metric, m) {
    if (!m) return 5;
    if (metric === 'flow') return 5 + Math.min(9, Math.log10(Math.max(m.v, 1)) * 2.6);
    if (metric === 'quality' || metric === 'temp' || metric === 'level') return 7;
    return 6;
  }

  function renderMap() {
    const box = $('#riverMap');
    if (!GEO) { box.innerHTML = '<div class="err">Map geometry could not be loaded.</div>'; return; }
    if (!Object.keys(DATA.sites).length) return;   // wait for readings

    // ---- bounds over geometry + stations
    let latMin = 90, latMax = -90, lonMin = 180, lonMax = -180;
    const bump = (la, lo) => {
      if (la < latMin) latMin = la; if (la > latMax) latMax = la;
      if (lo < lonMin) lonMin = lo; if (lo > lonMax) lonMax = lo;
    };
    GEO.river.forEach(p => bump(p[0], p[1]));
    Object.values(GEO.lakes).forEach(rs => rs.forEach(r => r.forEach(p => bump(p[0], p[1]))));
    STATIONS.forEach(s => bump(s.lat, s.lon));

    const padLat = (latMax - latMin) * 0.045, padLon = (lonMax - lonMin) * 0.045;
    latMin -= padLat; latMax += padLat; lonMin -= padLon; lonMax += padLon;

    const k = Math.cos((latMin + latMax) / 2 * Math.PI / 180);
    const spanX = (lonMax - lonMin) * k, spanY = latMax - latMin;
    const W = 780, H = Math.round(W * (spanY / spanX));
    const PAD = 34;
    const X = lo => ((lo - lonMin) * k / spanX) * (W - PAD * 2) + PAD;
    const Y = la => ((latMax - la) / spanY) * (H - 20) + 10;

    const NS = 'http://www.w3.org/2000/svg';
    const mk = (n, a) => {
      const e = document.createElementNS(NS, n);
      for (const q in a) if (a[q] != null) e.setAttribute(q, a[q]);
      return e;
    };
    const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img',
      'aria-label': 'Map of the Chattahoochee River with gauge readings' });
    svg.appendChild(mk('rect', { x: 0, y: 0, width: W, height: H, class: 'mapbg' }));

    // graticule
    for (let la = Math.ceil(latMin * 2) / 2; la <= latMax; la += 0.5) {
      svg.appendChild(mk('line', { x1: 0, y1: Y(la).toFixed(1), x2: W, y2: Y(la).toFixed(1), class: 'gridline' }));
    }
    for (let lo = Math.ceil(lonMin * 2) / 2; lo <= lonMax; lo += 0.5) {
      svg.appendChild(mk('line', { x1: X(lo).toFixed(1), y1: 0, x2: X(lo).toFixed(1), y2: H, class: 'gridline' }));
    }

    // lakes
    Object.values(GEO.lakes).forEach(rs => rs.forEach(r => {
      const d = r.map((p, i) => (i ? 'L' : 'M') + X(p[1]).toFixed(1) + ' ' + Y(p[0]).toFixed(1)).join(' ') + ' Z';
      svg.appendChild(mk('path', { d, class: 'lakepoly' }));
    }));

    // river
    const rd = GEO.river.map((p, i) => (i ? 'L' : 'M') + X(p[1]).toFixed(1) + ' ' + Y(p[0]).toFixed(1)).join(' ');
    svg.appendChild(mk('path', { d: rd, class: 'riverglow', 'stroke-width': 7 }));
    svg.appendChild(mk('path', { d: rd, class: 'riverline', 'stroke-width': 2.6 }));

    // places
    PLACES.forEach(p => {
      const x = X(p.lon), y = Y(p.lat);
      if (x < 0 || x > W || y < 0 || y > H) return;
      svg.appendChild(mk('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: 2, class: 'placedot' }));
      const t = mk('text', { x: (x + 5).toFixed(1), y: (y + 3).toFixed(1), class: 'placelbl' });
      t.textContent = p.name;
      svg.appendChild(t);
    });

    // scale bar (25 km)
    const kmPerDegLat = 111.0;
    const px25 = (25 / kmPerDegLat / spanY) * (H - 20);
    const sx = 14, sy = H - 16;
    svg.appendChild(mk('line', { x1: sx, y1: sy, x2: sx + px25, y2: sy, class: 'scalebar' }));
    svg.appendChild(mk('line', { x1: sx, y1: sy - 4, x2: sx, y2: sy + 4, class: 'scalebar' }));
    svg.appendChild(mk('line', { x1: sx + px25, y1: sy - 4, x2: sx + px25, y2: sy + 4, class: 'scalebar' }));
    const st = mk('text', { x: sx + px25 + 6, y: sy + 4, class: 'scaletxt' });
    st.textContent = '25 km';
    svg.appendChild(st);

    // ---- gauge markers (markers in one layer, labels above them all)
    const mLayer = mk('g', {}), lLayer = mk('g', {});
    const labels = [];
    STATIONS.forEach(s => {
      const m = metricValue(s, MAP_METRIC);
      const x = X(s.lon), y = Y(s.lat);
      // put labels into the open side of the frame
      const right = x < W * 0.42;
      // push labels apart until this one clears every label already placed
      let dy = 0, guard = 0;
      while (guard++ < 40 && labels.some(p => p.right === right &&
             Math.abs(p.x - x) < 115 && Math.abs((p.y + p.dy) - (y + dy)) < 23)) dy += 23;
      labels.push({ x, y, dy, right });

      const cls = 'gnode' + (MAP_SEL === s.id ? ' sel' : '') + (m ? '' : ' dim');
      const g = mk('g', { class: cls, tabindex: '0', role: 'button', 'aria-label': s.name });
      const lg = mk('g', { class: cls });
      const color = metricColor(s, MAP_METRIC, m);
      const r = metricRadius(MAP_METRIC, m);

      g.appendChild(mk('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: (r + 4).toFixed(1),
        class: 'halo', stroke: color }));
      g.appendChild(mk('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: r.toFixed(1),
        class: 'core', fill: color }));
      if (s.type === 'lake') {
        g.appendChild(mk('rect', { x: (x - 2).toFixed(1), y: (y - 2).toFixed(1), width: 4, height: 4,
          fill: '#08111f', transform: `rotate(45 ${x.toFixed(1)} ${y.toFixed(1)})` }));
      }

      const tx = right ? x + r + 7 : x - r - 7;
      const anchor = right ? 'start' : 'end';
      const ly = y + dy;
      // leader line when the label had to be nudged away from its marker
      if (dy > 2) {
        lg.appendChild(mk('line', { x1: (right ? x + r + 1 : x - r - 1).toFixed(1), y1: y.toFixed(1),
          x2: tx.toFixed(1), y2: (ly - 3).toFixed(1), class: 'leader', stroke: color }));
      }
      const n = mk('text', { x: tx.toFixed(1), y: (ly - 1).toFixed(1), 'text-anchor': anchor });
      n.textContent = s.name;
      lg.appendChild(n);
      const v = mk('text', { x: tx.toFixed(1), y: (ly + 9).toFixed(1), 'text-anchor': anchor,
        class: 'val', fill: color });
      v.textContent = m ? m.txt : 'not reported';
      lg.appendChild(v);

      const ti = document.createElementNS(NS, 'title');
      ti.textContent = `${s.name} — ${s.sub}\n${METRICS[MAP_METRIC].label}: ${m ? m.txt : 'not reported'}`;
      g.appendChild(ti);

      const pick = () => { MAP_SEL = s.id; renderMap(); showStation(s.id); };
      [g, lg].forEach(node => {
        node.addEventListener('click', pick);
        node.addEventListener('mouseenter', () => showStation(s.id, true));
      });
      g.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); } });
      mLayer.appendChild(g);
      lLayer.appendChild(lg);
    });
    svg.appendChild(mLayer);
    svg.appendChild(lLayer);

    box.innerHTML = '';
    box.appendChild(svg);
    renderLegend();
    if (!MAP_SEL) showStation(null);
  }

  function renderLegend() {
    const L = $('#mapLegend');
    if (!L) return;
    const sw = (c, t) => `<span><i class="sw" style="background:${c}"></i>${esc(t)}</span>`;
    if (MAP_METRIC === 'quality') {
      L.innerHTML = sw('#4ade80', 'Good') + sw('#fbbf24', 'Elevated') + sw('#f87171', 'Above threshold') +
        sw('#3d4d6d', 'No quality sensor');
    } else if (MAP_METRIC === 'temp') {
      L.innerHTML = sw('rgb(56,160,230)', 'Cold') + sw('rgb(150,120,155)', 'Mild') + sw('rgb(246,70,80)', 'Warm') +
        sw('#3d4d6d', 'No sensor');
    } else if (MAP_METRIC === 'flow') {
      L.innerHTML = sw('rgb(120,200,255)', 'Lower flow') + sw('rgb(24,140,215)', 'Higher flow') +
        '<span>Marker size scales with discharge</span>';
    } else {
      L.innerHTML = sw('#38bdf8', 'Gauge reading') + '<span>Reservoirs show pool elevation; rivers show stage</span>';
    }
    L.innerHTML += '<span class="dim">Geometry © OpenStreetMap contributors</span>';
  }

  function showStation(id, hover) {
    const side = $('#mapDetail');
    if (!side) return;
    if (!id) {
      side.innerHTML = '<p class="hint">Select a station on the map to see everything that gauge is reporting.</p>';
      return;
    }
    const s = SITE[id];
    const rows = [];
    const add = (label, code, fmtFn, unit) => {
      const r = get(id, code);
      if (!r) return;
      rows.push(`<tr><td class="name">${esc(label)}</td><td>${fmtFn(r.latest)}${unit ? ' ' + unit : ''}</td></tr>`);
    };
    add('Streamflow', P.flow, v => F(v, 0), 'cfs');
    add(s.type === 'lake' ? 'Pool elevation' : 'Stage', s.type === 'lake' ? P.elev : P.stage, v => F(v, 2), 'ft');
    add('Storage', P.storage, v => F(v, 0), 'kaf');
    add('Water temp', P.wtemp, v => F(cToF(v), 1), '°F');
    add('Dissolved oxygen', P.do, v => F(v, 1), 'mg/L');
    add('pH', P.ph, v => F(v, 1), '');
    add('Turbidity', P.turb, v => F(v, 1), 'FNU');
    add('E. coli', P.ecoli, v => F(v, 0), 'cfu/100mL');
    add('Conductance', P.spc, v => F(v, 0), 'µS/cm');
    add('Air temp', P.atemp, v => F(cToF(v), 1), '°F');
    add('Wind', P.wind, v => F(v, 1), 'mph');

    const primary = get(id, P.flow) || get(id, P.elev) || get(id, P.stage);
    const d24 = primary ? trend(primary.points, 24) : null;
    const upd = primary ? ago(primary.at) : '';

    side.innerHTML = `
      <h4>${esc(s.name)}</h4>
      <p class="sloc">${esc(s.sub)}</p>
      ${rows.length ? `<table>${rows.join('')}</table>` : '<p class="hint">This gauge is not reporting right now.</p>'}
      ${primary ? `<p class="sloc" style="margin:12px 0 0">24-hour change ${arrow(d24, get(id, P.flow) ? 0 : 2, get(id, P.flow) ? 'cfs' : 'ft')}
        · updated ${esc(upd)}</p>` : ''}
      <p class="sloc" style="margin-top:10px">
        <a href="https://waterdata.usgs.gov/monitoring-location/${esc(id)}/" target="_blank" rel="noopener">USGS ${esc(id)} ↗</a></p>`;
  }

  function renderRiver() {
    const rows = STATIONS.map(s => {
      const flow = get(s.id, P.flow), stage = get(s.id, P.stage);
      const elev = get(s.id, P.elev), wt = get(s.id, P.wtemp);
      const primary = flow || null;
      return { s, flow, stage, elev, wt, d24: primary ? trend(primary.points, 24) : (elev ? trend(elev.points, 24) : null) };
    });

    const html = `<div class="tablewrap"><table>
      <thead><tr>
        <th>Station</th><th>Flow (cfs)</th><th>24-hr change</th><th>Stage / pool (ft)</th>
        <th>Water temp</th><th>Updated</th>
      </tr></thead><tbody>
      ${rows.map(r => {
        const isLake = r.s.type === 'lake';
        const level = isLake && r.elev ? F(r.elev.latest, 2) : (r.stage ? F(r.stage.latest, 2) : '<span class="na">—</span>');
        const t = r.wt ? `${F(cToF(r.wt.latest), 1)}°F` : '<span class="na">—</span>';
        const upd = r.flow ? r.flow.at : (r.elev ? r.elev.at : (r.stage ? r.stage.at : null));
        return `<tr class="${r.s.id === '02339400' ? 'hl' : ''}">
          <td class="name">${esc(r.s.name)}<small>${esc(r.s.sub)}</small></td>
          <td>${r.flow ? F(r.flow.latest, 0) : '<span class="na">—</span>'}</td>
          <td>${r.flow ? arrow(r.d24, 0, 'cfs') : (r.elev ? arrow(r.d24, 2, 'ft') : '<span class="na">—</span>')}</td>
          <td>${level}</td><td>${t}</td>
          <td class="dim">${esc(ago(upd))}</td></tr>`;
      }).join('')}
      </tbody></table></div>
      <p class="cap" style="margin-top:14px">Highlighted row is West Point Lake. Stations are listed in downstream order —
        Lake Lanier at the top of the basin to West Point at the bottom.</p>`;
    $('#riverProfile').innerHTML = html;

    // hydrographs
    const palette = ['#38bdf8', '#a78bfa', '#4ade80', '#fbbf24', '#f472b6', '#22d3ee'];
    const picks = ['02334430', '02335000', '02336000', '02337170', '02338000', '02338500'];
    const series = [], chips = [];
    picks.forEach((id, i) => {
      const f = get(id, P.flow);
      if (!f) return;
      const cutoff = Date.now() - 7 * 86400000;
      const pts = f.points.filter(p => +p.t >= cutoff);
      if (!pts.length) return;
      series.push({ name: SITE[id].name, color: palette[i % palette.length], points: pts });
      chips.push(`<span class="chip"><i style="background:${palette[i % palette.length]}"></i>${esc(SITE[id].name)}
        — ${F(f.latest, 0)} cfs</span>`);
    });
    $('#flowChips').innerHTML = chips.join('');
    Charts.lineChart($('#flowChart'), series, { yDp: 0, unit: 'cfs', height: 320, minZero: true, emptyMsg: 'Streamflow data unavailable.' });
  }

  /* =====================================================================
     PANEL 3 — WATER QUALITY
     ===================================================================== */
  function renderQuality() {
    const atlEc = get('02336000', P.ecoli), norEc = get('02335000', P.ecoli);
    const atlTurb = get('02336000', P.turb), norTurb = get('02335000', P.turb);
    const fbDo = get('02337170', P.do), bufDo = get('02334430', P.do), fbPh = get('02337170', P.ph);

    // verdict driven by bacteria
    const ecVals = [atlEc, norEc].filter(Boolean).map(r => r.latest);
    let cls = 'info', label = 'Bacteria data unavailable', head = 'No live bacteria estimate right now', body =
      'The BacteriALERT sensors at Atlanta and Norcross are not reporting. Check turbidity and recent rainfall as a proxy.';
    if (ecVals.length) {
      const worst = Math.max.apply(null, ecVals);
      if (worst >= ECOLI_THRESHOLD * 2) {
        cls = 'bad'; label = 'Contact not advised';
        head = `E. coli estimated at ${F(worst, 0)} cfu/100 mL — far above the 235 threshold`;
        body = 'Bacteria are running well above the contact-recreation guideline, which typically follows heavy runoff. Avoid swimming, wading and any activity involving swallowing water.';
      } else if (worst >= ECOLI_THRESHOLD) {
        cls = 'bad'; label = 'Above safe threshold';
        head = `E. coli estimated at ${F(worst, 0)} cfu/100 mL — above the 235 threshold`;
        body = 'Bacteria exceed the single-sample guideline for contact recreation. Swimming and wading are discouraged until levels fall.';
      } else if (worst >= ECOLI_THRESHOLD * 0.5) {
        cls = 'warn'; label = 'Elevated';
        head = `E. coli estimated at ${F(worst, 0)} cfu/100 mL — below the threshold but climbing`;
        body = 'Levels are under the 235 guideline but elevated. Rain in the next day or two would likely push them over.';
      } else {
        cls = 'good'; label = 'Good';
        head = `E. coli estimated at ${F(worst, 0)} cfu/100 mL — comfortably below the 235 threshold`;
        body = 'Bacteria are low and conditions are favorable for contact recreation. Levels can spike within hours of heavy rain.';
      }
    }
    $('#qualityVerdict').innerHTML = `<span class="badge ${cls}">${esc(label)}</span>
      <h2>${esc(head)}</h2><p>${body}</p>`;

    const kpi = (lbl, v, unit, note, k) =>
      `<div class="kpi ${k || ''}"><div class="lbl">${esc(lbl)}</div>
       <div class="big">${v === null || v === undefined ? '—' : esc(v) + (unit ? ' ' + unit : '')}</div>
       <div class="note">${esc(note)}</div></div>`;

    const doVal = fbDo ? fbDo.latest : null;
    $('#qualityKpis').innerHTML = [
      kpi('E. coli — Atlanta', atlEc ? F(atlEc.latest, 0) : null, 'cfu', 'threshold 235 · ' + (atlEc ? ago(atlEc.at) : 'no data'),
        atlEc ? (atlEc.latest >= ECOLI_THRESHOLD ? 'bad' : atlEc.latest >= ECOLI_THRESHOLD / 2 ? 'warn' : 'good') : ''),
      kpi('E. coli — Norcross', norEc ? F(norEc.latest, 0) : null, 'cfu', 'threshold 235 · ' + (norEc ? ago(norEc.at) : 'no data'),
        norEc ? (norEc.latest >= ECOLI_THRESHOLD ? 'bad' : norEc.latest >= ECOLI_THRESHOLD / 2 ? 'warn' : 'good') : ''),
      kpi('Turbidity — Atlanta', atlTurb ? F(atlTurb.latest, 1) : null, 'FNU', 'suspended sediment'),
      kpi('Dissolved oxygen — Fairburn', doVal !== null ? F(doVal, 1) : null, 'mg/L', 'standard is 5.0 minimum',
        doVal === null ? '' : (doVal < DO_MIN ? 'bad' : doVal < DO_MIN + 1 ? 'warn' : 'good')),
      kpi('pH — Fairburn', fbPh ? F(fbPh.latest, 1) : null, '', 'normal range 6.0 – 8.5',
        fbPh ? (fbPh.latest < 6 || fbPh.latest > 8.5 ? 'warn' : 'good') : ''),
      kpi('Water temp — Atlanta', get('02336000', P.wtemp) ? F(cToF(val('02336000', P.wtemp)), 1) : null, '°F', 'river temperature')
    ].join('');

    Charts.lineChart($('#ecoliChart'), [
      atlEc && { name: 'Atlanta', color: '#f472b6', points: atlEc.points },
      norEc && { name: 'Norcross', color: '#a78bfa', points: norEc.points }
    ].filter(Boolean), {
      yDp: 0, unit: 'cfu/100mL', height: 300, minZero: true,
      threshold: ECOLI_THRESHOLD, thresholdLabel: '235 — contact threshold',
      emptyMsg: 'BacteriALERT sensors are not reporting.'
    });

    Charts.lineChart($('#turbChart'), [
      atlTurb && { name: 'Atlanta', color: '#fbbf24', points: atlTurb.points, fill: true },
      norTurb && { name: 'Norcross', color: '#38bdf8', points: norTurb.points }
    ].filter(Boolean), { yDp: 1, unit: 'FNU', height: 260, minZero: true, emptyMsg: 'Turbidity sensors are not reporting.' });

    Charts.lineChart($('#doChart'), [
      fbDo && { name: 'DO — Fairburn', color: '#4ade80', points: fbDo.points },
      bufDo && { name: 'DO — Buford Dam', color: '#22d3ee', points: bufDo.points }
    ].filter(Boolean), {
      yDp: 1, unit: 'mg/L', height: 260, threshold: DO_MIN, thresholdLabel: '5.0 mg/L standard',
      emptyMsg: 'Dissolved oxygen sensors are not reporting.'
    });

    const notes = [];
    if (atlTurb) notes.push(`<b>Turbidity is the tell.</b> Atlanta is at ${F(atlTurb.latest, 1)} FNU.
      Readings under about 10 FNU mean clear water; a jump into the dozens or hundreds means runoff is
      washing sediment — and bacteria — into the river.`);
    notes.push(`<b>Bacteria follow rain, not the calendar.</b> E. coli here is a continuous model estimate from
      turbidity and flow, not a lab culture. Levels typically spike within 12–24 hours of heavy rain and fall
      back over the following day or two.`);
    if (doVal !== null) notes.push(`<b>Dissolved oxygen at Fairburn is ${F(doVal, 1)} mg/L.</b>
      ${doVal < DO_MIN ? 'That is below Georgia\'s 5.0 mg/L warm-water standard, which stresses fish.'
        : 'That is above Georgia\'s 5.0 mg/L minimum, so the fishery is well supplied.'}
      Oxygen naturally falls as water warms, so late summer is the annual low point.`);
    notes.push(`<b>Cold water below the dams.</b> Buford Dam releases water drawn from deep in Lake Lanier, so the
      river below it runs far colder than the river at Atlanta — that is why a trout fishery exists there.`);
    notes.push(`<b>These are provisional readings.</b> Sensors drift, foul and fail. Treat a single strange value
      with suspicion and look at the trend instead.`);
    $('#qualityNotes').innerHTML = notes.map(n => '<li>' + n + '</li>').join('');
  }

  /* =====================================================================
     PANEL 4 — WEATHER
     ===================================================================== */
  function loadWeather() {
    const om = 'https://api.open-meteo.com/v1/forecast?latitude=' + LAGRANGE.lat + '&longitude=' + LAGRANGE.lon +
      '&daily=precipitation_sum,precipitation_probability_max,temperature_2m_max,temperature_2m_min' +
      '&current=temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation,weather_code' +
      '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch' +
      '&timezone=America%2FNew_York&forecast_days=10';

    const nws = fetchJSON('https://api.weather.gov/gridpoints/FFC/29,53/forecast', 20000).catch(() => null);
    const meteo = fetchJSON(om, 20000).catch(() => null);
    return Promise.all([nws, meteo]).then(([n, m]) => { DATA.wx = { nws: n, om: m }; });
  }

  function renderWeather() {
    const om = DATA.wx && DATA.wx.om, nws = DATA.wx && DATA.wx.nws;

    // current conditions
    const lakeT = val('02339400', P.atemp), lakeW = val('02339400', P.wind), lakeRh = val('02339400', P.rh);
    if (om && om.current) {
      const c = om.current;
      $('#nowWx').innerHTML = `
        <h3>Right now — LaGrange &amp; West Point Lake</h3>
        <div class="wxnow" style="margin-top:14px">
          <div class="temp">${F(c.temperature_2m, 0)}°F</div>
          <div class="meta">
            Humidity <b>${F(c.relative_humidity_2m, 0)}%</b> · Wind <b>${F(c.wind_speed_10m, 0)} mph</b><br/>
            ${lakeT !== null ? `On the lake: <b>${F(cToF(lakeT), 0)}°F</b>` : ''}
            ${lakeW !== null ? ` · wind <b>${F(lakeW, 1)} mph</b>` : ''}
            ${lakeRh !== null ? ` · humidity <b>${F(lakeRh, 0)}%</b>` : ''}
          </div>
        </div>`;
    } else {
      err('#nowWx', 'Current conditions are unavailable.');
    }

    // NWS narrative forecast
    if (nws && nws.properties && nws.properties.periods) {
      const per = nws.properties.periods.slice(0, 8);
      $('#forecast').innerHTML = '<div class="fc">' + per.map(p => `
        <div class="fcd">
          <div class="d">${esc(p.name.length > 14 ? p.name.slice(0, 13) + '…' : p.name)}</div>
          <img src="${esc(p.icon)}" alt="" loading="lazy"/>
          <div class="t">${p.temperature}°</div>
          <div class="p">${p.probabilityOfPrecipitation && p.probabilityOfPrecipitation.value ?
            p.probabilityOfPrecipitation.value + '% rain' : ''}</div>
          <div class="s">${esc(p.shortForecast)}</div>
        </div>`).join('') + '</div>';
    } else {
      err('#forecast', 'NWS forecast is unavailable.');
    }

    // rain forecast bars
    if (om && om.daily) {
      const d = om.daily;
      const items = d.time.map((t, i) => {
        const dt = new Date(t + 'T12:00:00');
        return {
          label: dt.toLocaleDateString([], { weekday: 'short' }),
          sub: (dt.getMonth() + 1) + '/' + dt.getDate(),
          value: d.precipitation_sum[i] || 0,
          title: `${dt.toDateString()}: ${F(d.precipitation_sum[i] || 0, 2)} in · ` +
                 `${d.precipitation_probability_max[i] || 0}% chance · ` +
                 `${F(d.temperature_2m_max[i], 0)}/${F(d.temperature_2m_min[i], 0)}°F`,
          opacity: 0.35 + 0.65 * ((d.precipitation_probability_max[i] || 0) / 100)
        };
      });
      Charts.barSimple($('#rainFcChart'), items, { yDp: 2, unit: 'in', height: 250, minTop: 0.5 });
      const total = d.precipitation_sum.reduce((a, b) => a + (b || 0), 0);
      $('#rainFcChart').insertAdjacentHTML('afterend',
        `<p class="cap" style="margin-top:10px"><b>${F(total, 2)} in</b> total expected over the next 10 days.
         Bar opacity reflects confidence — faint bars are low-probability.</p>`);
    } else {
      err('#rainFcChart', 'Rain forecast is unavailable.');
    }

    // basin rainfall last 7 days from gauge precip accumulators
    renderBasinRain();

    // lake weather stations
    const wxCard = (id, title) => {
      const t = val(id, P.atemp), w = val(id, P.wind), wd = val(id, P.windDir),
        rh = val(id, P.rh), bp = val(id, P.baro);
      if (t === null && w === null) return '';
      const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
      const dir = wd === null ? '' : dirs[Math.round(wd / 22.5) % 16];
      return `<div class="card" style="margin:0">
        <h3>${esc(title)}</h3>
        <table style="margin-top:10px">
          ${t !== null ? `<tr><td class="name">Air temperature</td><td>${F(cToF(t), 1)}°F</td></tr>` : ''}
          ${w !== null ? `<tr><td class="name">Wind</td><td>${F(w, 1)} mph ${esc(dir)}</td></tr>` : ''}
          ${rh !== null ? `<tr><td class="name">Humidity</td><td>${F(rh, 0)}%</td></tr>` : ''}
          ${bp !== null ? `<tr><td class="name">Pressure</td><td>${F(bp, 0)} mmHg</td></tr>` : ''}
        </table></div>`;
    };
    $('#lakeWx').innerHTML = wxCard('02339400', 'West Point Lake station') + wxCard('02334400', 'Lake Lanier station');
  }

  // Basin rainfall depends on USGS data, which loads in parallel with the weather
  // feeds — so this is rendered separately and re-run once water data arrives.
  function renderBasinRain() {
    const box = $('#basinRain');
    if (!box) return;
    if (!Object.keys(DATA.sites).length) return;   // water not in yet; will be called again

    const rainSites = ['02338500', '02339400', '02339500', '02335000', '02337170', '02338000'];
    const cutoff = Date.now() - 7 * 86400000;
    const rows = rainSites.map(id => {
      const r = get(id, P.precip);
      if (!r) return null;
      const pts = r.points.filter(p => +p.t >= cutoff);
      if (!pts.length) return null;
      // USGS 00045 is incremental per interval, so summing gives the period total
      const total = pts.reduce((a, p) => a + (p.v > 0 ? p.v : 0), 0);
      return { name: SITE[id] ? SITE[id].name : id, total };
    }).filter(Boolean).sort((a, b) => b.total - a.total);

    box.innerHTML = rows.length
      ? `<table>${rows.map(r => `<tr><td class="name">${esc(r.name)}</td><td>${F(r.total, 2)} in</td></tr>`).join('')}</table>
         <p class="cap" style="margin-top:12px">Seven-day rainfall totals from tipping-bucket gauges at each station.
           Heavy totals upstream at Norcross or Whitesburg will reach West Point Lake over the following few days.</p>`
      : '<div class="err">No rainfall gauge data reported in the last 7 days.</div>';
  }

  /* =====================================================================
     PANEL 5 — CAMERAS
     ===================================================================== */
  // Public GDOT / 511GA traffic cameras at or near Chattahoochee crossings,
  // ordered downstream. Verified live 2026-08-16.
  const CAMERAS = [
    { id: '21734', name: 'I-285 at Riverview Rd', loc: 'I-285 counter-clockwise, MM 15.4 — Cobb County', tag: 'River crossing' },
    { id: '21553', name: 'I-285 at Powers Ferry Rd', loc: 'I-285 counter-clockwise, MM 22.5 — Cobb County', tag: 'River crossing' },
    { id: '22563', name: 'Cumberland Blvd at Walton Riverwood Ln', loc: 'Cobb County — river corridor', tag: 'Near river' },
    { id: '22555', name: 'Cumberland Blvd at Interstate North Pkwy', loc: 'Cobb County — river corridor', tag: 'Near river' },
    { id: '18596', name: 'Northside Pkwy at River Green Dr', loc: 'SR 3, Atlanta — on the riverbank', tag: 'Riverbank' },
    { id: '22559', name: 'Cumberland Blvd at Cobb Galleria Pkwy', loc: 'Cobb County', tag: 'Near river' },
    { id: '22560', name: 'Cumberland Blvd at I-75 N', loc: 'Cobb County', tag: 'Near river' },
    { id: '19900', name: 'SR 1 at SR 5', loc: 'Carroll County — upper basin', tag: 'Basin' },
    { id: '19696', name: 'SR 219 at Pegasus Pkwy', loc: 'Troup County — LaGrange / West Point Lake', tag: 'Lake area' },
    { id: '21812', name: 'I-85 near Old West Point Rd', loc: 'Harris County, MM 0.5 — near West Point', tag: 'Near dam' }
  ];
  const CAM_BASE = 'https://511ga.org/map/Cctv/';

  function renderCams() {
    const grid = $('#camGrid');
    if (grid.dataset.built) return;
    grid.dataset.built = '1';
    grid.innerHTML = CAMERAS.map(c => `
      <div class="cam">
        <figure>
          <img id="cam-${esc(c.id)}" alt="${esc(c.name)} traffic camera" loading="lazy"
               referrerpolicy="no-referrer"
               onerror="this.style.display='none';this.insertAdjacentHTML('afterend','<div class=\\'camfail\\'>Camera image unavailable</div>')"/>
        </figure>
        <div class="meta">
          <div class="cname">${esc(c.name)}</div>
          <div class="cloc">${esc(c.loc)}</div>
          <span class="ctag">${esc(c.tag)}</span>
        </div>
      </div>`).join('');
    refreshCams();
  }

  function refreshCams() {
    const stamp = Date.now();
    CAMERAS.forEach(c => {
      const img = document.getElementById('cam-' + c.id);
      if (img) img.src = CAM_BASE + c.id + '?_t=' + stamp;
    });
    const n = $('#camNote');
    if (n) n.textContent = 'Images refreshed ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  /* =====================================================================
     PANEL 6 — RAIN CLIMATOLOGY
     ===================================================================== */
  function loadRain() {
    return fetchJSON('data/rain-climatology.json', 20000).then(j => { DATA.rain = j; });
  }

  function renderRain() {
    const R = DATA.rain;
    if (!R) return err('#rainVerdict', 'Rainfall climatology data could not be loaded.');

    const y = R.ytd, cls = Math.abs(y.z_days) < 1 ? 'good' : Math.abs(y.z_days) < 1.75 ? 'warn' : 'bad';
    $('#rainVerdict').innerHTML = `
      <span class="badge ${cls}">${esc(y.verdict_days)}</span>
      <h2>${R.current_year} so far: <b>${y.days} rain days</b> and <b>${F(y.inches, 2)} in</b> through ${esc(R.through_label)}</h2>
      <p>The ${R.baseline_label} average for this same window is <b>${F(y.avg_days, 1)} rain days</b>
        (range ${y.min_days}–${y.max_days}) and <b>${F(y.avg_inches, 2)} in</b>
        (range ${F(y.min_inches, 2)}–${F(y.max_inches, 2)}).
        That puts ${R.current_year} at <b>${y.z_days >= 0 ? '+' : ''}${F(y.z_days, 2)} standard deviations</b> on rain-day count —
        the <b>#${y.rank_days}</b> wettest of ${y.n_years} years by frequency and <b>#${y.rank_inches}</b> by total rainfall.</p>`;

    $('#rainKpis').innerHTML = [
      `<div class="kpi"><div class="lbl">Rain days, year to date</div><div class="big">${y.days}</div>
        <div class="note">vs ${F(y.avg_days, 1)} average · ${y.days - y.avg_days >= 0 ? '+' : ''}${F(y.days - y.avg_days, 1)}</div></div>`,
      `<div class="kpi"><div class="lbl">Rainfall, year to date</div><div class="big">${F(y.inches, 2)}"</div>
        <div class="note">vs ${F(y.avg_inches, 2)}" average · ${y.inches - y.avg_inches >= 0 ? '+' : ''}${F(y.inches - y.avg_inches, 2)}"</div></div>`,
      `<div class="kpi"><div class="lbl">Wettest month this year</div><div class="big">${esc(R.wettest.name)}</div>
        <div class="note">${F(R.wettest.cur_in, 2)}" · average ${F(R.wettest.avg_in, 2)}"</div></div>`,
      `<div class="kpi"><div class="lbl">Biggest surplus</div><div class="big" style="font-size:22px">${esc(R.wettest_gap.name)} ${R.wettest_gap.gap >= 0 ? '+' : ''}${F(R.wettest_gap.gap, 1)}"</div>
        <div class="note">driest vs normal: ${esc(R.driest_gap.name)} ${F(R.driest_gap.gap, 1)}"</div></div>`
    ].join('');

    Charts.barCompare($('#rainDaysChart'), R.months,
      { cur: 'cur_days', avg: 'avg_days', min: 'min_days', max: 'max_days' },
      { yDp: 0, unit: 'days', curLabel: R.current_year, height: 310 });

    Charts.barCompare($('#rainInChart'), R.months,
      { cur: 'cur_in', avg: 'avg_in', min: 'min_in', max: 'max_in' },
      { yDp: 1, unit: 'in', curLabel: R.current_year, height: 310 });

    Charts.barYears($('#ytdDaysChart'),
      R.ytd_by_year.map(r => ({ label: r.year, value: r.days, highlight: r.year === R.current_year })),
      { yDp: 0, unit: 'rain days', avg: y.avg_days, avgLabel: R.baseline_label + ' avg ' + F(y.avg_days, 1), height: 250 });

    Charts.barYears($('#ytdInChart'),
      R.ytd_by_year.map(r => ({ label: r.year, value: r.inches, highlight: r.year === R.current_year })),
      { yDp: 1, unit: 'inches', avg: y.avg_inches, avgLabel: R.baseline_label + ' avg ' + F(y.avg_inches, 1) + '"', height: 250 });

    $('#rainTable').innerHTML = `
      <thead><tr><th>Month</th><th>${R.current_year} days</th><th>Avg days</th><th>Range</th>
        <th>${R.current_year} inches</th><th>Avg inches</th><th>Range</th><th>Day anomaly</th></tr></thead>
      <tbody>${R.months.map(m => {
        const has = m.cur_days !== null && m.cur_days !== undefined;
        const star = m.partial ? ' <span class="dim">*</span>' : '';
        const diff = has ? m.cur_days - m.avg_days : null;
        return `<tr>
          <td class="name">${esc(m.name)}</td>
          <td>${has ? m.cur_days + star : '<span class="na">—</span>'}</td>
          <td class="dim">${F(m.avg_days, 1)}</td>
          <td class="dim">${m.min_days}–${m.max_days}</td>
          <td>${has ? F(m.cur_in, 2) + star : '<span class="na">—</span>'}</td>
          <td class="dim">${F(m.avg_in, 2)}</td>
          <td class="dim">${F(m.min_in, 2)}–${F(m.max_in, 2)}</td>
          <td>${has ? arrow(diff, 1, 'days') : '<span class="na">not yet</span>'}</td></tr>`;
      }).join('')}</tbody>`;
  }

  /* =====================================================================
     bootstrap
     ===================================================================== */
  function setUpdated(ok) {
    DATA.fetchedAt = new Date();
    $('#updated').textContent = (ok ? 'Live · updated ' : 'Partial data · ') +
      DATA.fetchedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    $('#builtAt').textContent = 'Last refreshed ' + DATA.fetchedAt.toLocaleString();
  }

  function loadAll() {
    $('#updated').textContent = 'Refreshing…';
    const water = loadWater().then(() => {
      renderLake(); renderRiver(); renderQuality(); renderBasinRain(); renderMap();
    }).catch(e => {
      console.error(e);
      ['#lakeHero', '#riverProfile', '#qualityVerdict'].forEach(s =>
        err(s, 'Could not reach the USGS water service. It may be briefly down — try Refresh.'));
    });

    const geo = loadGeo().then(renderMap)
      .catch(e => { console.error(e); err('#riverMap', 'Map geometry could not be loaded.'); });

    const weather = loadWeather().then(renderWeather)
      .catch(e => { console.error(e); err('#nowWx', 'Weather services are unavailable.'); });

    const rain = (DATA.rain ? Promise.resolve() : loadRain()).then(renderRain)
      .catch(e => { console.error(e); err('#rainVerdict', 'Rainfall climatology could not be loaded.'); });

    return Promise.all([water, weather, rain, geo]).then(() => setUpdated(true));
  }

  // metric selector for the river map
  $$('#metricBar .mbtn').forEach(b => b.addEventListener('click', () => {
    $$('#metricBar .mbtn').forEach(o => o.classList.remove('active'));
    b.classList.add('active');
    MAP_METRIC = b.dataset.metric;
    renderMap();
  }));

  // tabs
  $$('.tab').forEach(t => t.addEventListener('click', () => {
    $$('.tab').forEach(x => x.classList.remove('active'));
    $$('.panel').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    const p = document.getElementById('panel-' + t.dataset.panel);
    if (p) p.classList.add('active');
    if (t.dataset.panel === 'cams') renderCams();
    if (location.hash !== '#' + t.dataset.panel) history.replaceState(null, '', '#' + t.dataset.panel);
  }));

  if (location.hash) {
    const t = $$('.tab').find(x => '#' + x.dataset.panel === location.hash);
    if (t) t.click();
  }

  $('#refresh').addEventListener('click', () => { loadAll(); if ($('#camGrid').dataset.built) refreshCams(); });
  $('#camRefresh').addEventListener('click', refreshCams);
  loadAll();
  setInterval(loadAll, 15 * 60 * 1000);      // auto-refresh data every 15 minutes
  setInterval(() => {                        // refresh camera stills while visible
    if ($('#panel-cams').classList.contains('active') && !document.hidden) refreshCams();
  }, 60 * 1000);
  window.addEventListener('focus', () => {
    if (DATA.fetchedAt && Date.now() - DATA.fetchedAt > 10 * 60 * 1000) loadAll();
  });
})();
