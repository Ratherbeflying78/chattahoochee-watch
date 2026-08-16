#!/usr/bin/env python3
"""
Rebuild data/rain-climatology.json for Chattahoochee Watch.

Pulls the full daily precipitation record for LaGrange, GA from the Open-Meteo
archive (ERA5 reanalysis) and reduces it to the monthly / year-to-date summary
the dashboard renders. Run daily from CI.
"""
import json
import os
import statistics
import sys
import urllib.request
from datetime import date, timedelta

LAT, LON = 33.0362, -85.0313
BASELINE_START = 2015
WET = 0.01  # inches — threshold for a "measurable rain day"
MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug',
       'Sep', 'Oct', 'Nov', 'Dec']

OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'rain-climatology.json')


def fetch(url, retries=4):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'chattahoochee-watch'})
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.load(r)
        except Exception as exc:          # noqa: BLE001 - retry any transport error
            last = exc
            print(f'  attempt {attempt + 1} failed: {exc}', file=sys.stderr)
    raise SystemExit(f'Could not fetch archive data: {last}')


def verdict(z):
    a = abs(z)
    if a < 0.5:
        return 'Normal'
    if a < 1.0:
        return 'Slightly ' + ('above' if z > 0 else 'below') + ' normal'
    if a < 1.75:
        return 'Notably ' + ('wetter' if z > 0 else 'drier') + ' than normal'
    return 'Unusually ' + ('wet' if z > 0 else 'dry')


def main():
    # ERA5 lags a few days; ask through today and accept what we get.
    end = date.today()
    url = ('https://archive-api.open-meteo.com/v1/archive'
           f'?latitude={LAT}&longitude={LON}'
           f'&start_date={BASELINE_START}-01-01&end_date={end.isoformat()}'
           '&daily=precipitation_sum&timezone=America%2FNew_York&precipitation_unit=inch')
    print(f'Fetching {BASELINE_START}-01-01 .. {end.isoformat()} …')
    raw = fetch(url)

    times = raw['daily']['time']
    prec = [p if p is not None else 0.0 for p in raw['daily']['precipitation_sum']]

    # Trim trailing days that have no real data yet (ERA5 latency).
    while times and raw['daily']['precipitation_sum'][len(times) - 1] is None:
        times.pop()
        prec.pop()
    if not times:
        raise SystemExit('Archive returned no usable days.')

    last = times[-1]
    cy, cm, cd = (int(x) for x in last.split('-'))
    print(f'Record ends {last} ({len(times)} days)')

    # year -> month -> [rain_days, inches]
    data = {}
    for t, p in zip(times, prec):
        y, m = int(t[0:4]), int(t[5:7])
        e = data.setdefault(y, {}).setdefault(m, [0, 0.0])
        if p >= WET:
            e[0] += 1
        e[1] += p

    years = sorted(data)
    base_years = [y for y in years if y < cy]
    if not base_years:
        raise SystemExit('Need at least one complete prior year.')

    months = []
    for m in range(1, 13):
        cur = data.get(cy, {}).get(m)
        hd = [data[y][m][0] for y in base_years if m in data[y]]
        hi = [data[y][m][1] for y in base_years if m in data[y]]
        months.append({
            'month': m,
            'name': MON[m - 1],
            'cur_days': cur[0] if cur else None,
            'cur_in': round(cur[1], 2) if cur else None,
            'avg_days': round(statistics.mean(hd), 1) if hd else None,
            'avg_in': round(statistics.mean(hi), 2) if hi else None,
            'min_days': min(hd) if hd else None,
            'max_days': max(hd) if hd else None,
            'min_in': round(min(hi), 2) if hi else None,
            'max_in': round(max(hi), 2) if hi else None,
            'partial': bool(cur) and m == cm,
        })

    # Year-to-date over the identical calendar window in every year.
    def ytd(y):
        days, inches = 0, 0.0
        for t, p in zip(times, prec):
            yy, mm, dd = int(t[0:4]), int(t[5:7]), int(t[8:10])
            if yy != y or (mm, dd) > (cm, cd):
                continue
            inches += p
            if p >= WET:
                days += 1
        return days, round(inches, 2)

    ytds = {y: ytd(y) for y in years}
    cur_d, cur_i = ytds[cy]
    bd = [ytds[y][0] for y in base_years]
    bi = [ytds[y][1] for y in base_years]
    avg_d, avg_i = statistics.mean(bd), statistics.mean(bi)
    sd_d, sd_i = statistics.pstdev(bd), statistics.pstdev(bi)
    z_d = (cur_d - avg_d) / sd_d if sd_d else 0.0
    z_i = (cur_i - avg_i) / sd_i if sd_i else 0.0

    elapsed = [m for m in months if m['cur_in'] is not None]
    wettest = max(elapsed, key=lambda r: r['cur_in'])
    gaps = [dict(name=r['name'], gap=round(r['cur_in'] - r['avg_in'], 2)) for r in elapsed]
    wettest_gap = max(gaps, key=lambda g: g['gap'])
    driest_gap = min(gaps, key=lambda g: g['gap'])

    doc = {
        'generated': date.today().isoformat(),
        'location': 'LaGrange, Georgia',
        'latitude': LAT, 'longitude': LON,
        'source': 'Open-Meteo archive (ERA5 reanalysis)',
        'wet_day_threshold_in': WET,
        'current_year': cy,
        'data_through': last,
        'through_label': f'{MON[cm - 1]} {cd}',
        'baseline_label': f'{base_years[0]}\u2013{base_years[-1]}',
        'months': months,
        'ytd_by_year': [{'year': y, 'days': ytds[y][0], 'inches': ytds[y][1]} for y in years],
        'ytd': {
            'days': cur_d, 'inches': cur_i,
            'avg_days': round(avg_d, 1), 'avg_inches': round(avg_i, 2),
            'min_days': min(bd), 'max_days': max(bd),
            'min_inches': min(bi), 'max_inches': max(bi),
            'z_days': round(z_d, 2), 'z_inches': round(z_i, 2),
            'rank_days': sorted(years, key=lambda y: -ytds[y][0]).index(cy) + 1,
            'rank_inches': sorted(years, key=lambda y: -ytds[y][1]).index(cy) + 1,
            'n_years': len(years),
            'verdict_days': verdict(z_d),
            'verdict_inches': verdict(z_i),
        },
        'wettest': {'name': wettest['name'], 'cur_in': wettest['cur_in'], 'avg_in': wettest['avg_in']},
        'wettest_gap': wettest_gap,
        'driest_gap': driest_gap,
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(doc, f, indent=1)
    print(f'Wrote {os.path.abspath(OUT)}')
    print(f'  YTD {cur_d} days / {cur_i:.2f} in  vs  {avg_d:.1f} / {avg_i:.2f}  '
          f'(z={z_d:+.2f}) -> {doc["ytd"]["verdict_days"]}')


if __name__ == '__main__':
    main()
