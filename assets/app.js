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
    { id: '02334400', name: 'Lake Sidney Lanier', sub: 'near Buford — headwater reservoir', type: 'lake', rm: 348 },
    { id: '02334430', name: 'Buford Dam', sub: 'Chattahoochee R. at Buford Dam', type: 'river', rm: 348 },
    { id: '02335000', name: 'Norcross', sub: 'Chattahoochee R. near Norcross', type: 'river', rm: 320 },
    { id: '02335450', name: 'Above Roswell', sub: 'Chattahoochee R. above Roswell', type: 'river', rm: 309 },
    { id: '02335815', name: 'Morgan Falls Dam', sub: 'below Morgan Falls Dam', type: 'river', rm: 305 },
    { id: '02336000', name: 'Atlanta', sub: 'Chattahoochee R. at Atlanta (US 41)', type: 'river', rm: 300 },
    { id: '02336490', name: 'GA 280 near Atlanta', sub: 'below Peachtree Creek', type: 'river', rm: 294 },
    { id: '02337170', name: 'Fairburn', sub: 'Chattahoochee R. near Fairburn', type: 'river', rm: 277 },
    { id: '02338000', name: 'Whitesburg', sub: 'Chattahoochee R. near Whitesburg', type: 'river', rm: 253 },
    { id: '02338500', name: 'Franklin', sub: 'Chattahoochee R. at GA 100 — lake inflow', type: 'river', rm: 235 },
    { id: '02339400', name: 'West Point Lake', sub: 'reservoir pool near West Point', type: 'lake', rm: 205 },
    { id: '02339402', name: 'Below West Point Dam', sub: 'tailwater stage', type: 'river', rm: 201 },
    { id: '02339500', name: 'West Point', sub: 'Chattahoochee R. at West Point', type: 'river', rm: 200 }
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
      renderLake(); renderRiver(); renderQuality(); renderBasinRain();
    }).catch(e => {
      console.error(e);
      ['#lakeHero', '#riverProfile', '#qualityVerdict'].forEach(s =>
        err(s, 'Could not reach the USGS water service. It may be briefly down — try Refresh.'));
    });

    const weather = loadWeather().then(renderWeather)
      .catch(e => { console.error(e); err('#nowWx', 'Weather services are unavailable.'); });

    const rain = (DATA.rain ? Promise.resolve() : loadRain()).then(renderRain)
      .catch(e => { console.error(e); err('#rainVerdict', 'Rainfall climatology could not be loaded.'); });

    return Promise.all([water, weather, rain]).then(() => setUpdated(true));
  }

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
