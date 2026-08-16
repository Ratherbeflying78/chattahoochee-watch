#!/usr/bin/env python3
"""
Append a daily snapshot of key gauge readings to data/history/daily.json.

The dashboard reads live values directly from USGS in the browser, but USGS only
serves a limited instantaneous-value window. This script preserves one row per
day so long-run trends survive.
"""
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

SITES = {
    '02339400': 'west_point_lake',
    '02338500': 'franklin_inflow',
    '02339500': 'west_point_outflow',
    '02334400': 'lanier',
    '02334430': 'buford_release',
    '02336000': 'atlanta',
    '02335000': 'norcross',
    '02337170': 'fairburn',
}
PARAMS = {
    '00060': 'flow_cfs', '00065': 'stage_ft', '00062': 'elev_ft',
    '72036': 'storage_kaf', '00010': 'wtemp_c', '00300': 'do_mgl',
    '00400': 'ph', '00095': 'spc_uscm', '63680': 'turbidity_fnu',
    '99407': 'ecoli_cfu',
}
HIST = os.path.join(os.path.dirname(__file__), '..', 'data', 'history', 'daily.json')
MAX_ROWS = 4000  # ~11 years of daily rows


def fetch(url, retries=4):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'chattahoochee-watch'})
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.load(r)
        except Exception as exc:          # noqa: BLE001
            last = exc
            print(f'  attempt {attempt + 1} failed: {exc}', file=sys.stderr)
    raise SystemExit(f'USGS fetch failed: {last}')


def main():
    url = ('https://waterservices.usgs.gov/nwis/iv/?format=json'
           f'&sites={",".join(SITES)}&period=P1D&siteStatus=all')
    print('Fetching current USGS values …')
    data = fetch(url)

    row = {'date': datetime.now(timezone.utc).strftime('%Y-%m-%d'),
           'captured_utc': datetime.now(timezone.utc).isoformat(timespec='seconds')}

    for ts in data.get('value', {}).get('timeSeries', []):
        site = ts['sourceInfo']['siteCode'][0]['value']
        code = ts['variable']['variableCode'][0]['value']
        if site not in SITES or code not in PARAMS:
            continue
        vals = [v for v in ts['values'][0]['value'] if v.get('value') not in (None, '')]
        if not vals:
            continue
        try:
            v = float(vals[-1]['value'])
        except ValueError:
            continue
        if v <= -999998:      # USGS no-data sentinel
            continue
        row[f'{SITES[site]}__{PARAMS[code]}'] = round(v, 3)

    measures = len(row) - 2
    if measures == 0:
        print('No usable readings returned; leaving history untouched.', file=sys.stderr)
        return 0

    os.makedirs(os.path.dirname(HIST), exist_ok=True)
    history = []
    if os.path.exists(HIST):
        try:
            with open(HIST, encoding='utf-8') as f:
                history = json.load(f)
            if not isinstance(history, list):
                history = []
        except (json.JSONDecodeError, OSError) as exc:
            print(f'Existing history unreadable ({exc}); starting fresh.', file=sys.stderr)
            history = []

    history = [h for h in history if h.get('date') != row['date']]
    history.append(row)
    history.sort(key=lambda h: h.get('date', ''))
    history = history[-MAX_ROWS:]

    with open(HIST, 'w', encoding='utf-8') as f:
        json.dump(history, f, indent=0, separators=(',', ':'))

    print(f'Recorded {measures} measurements for {row["date"]} '
          f'({len(history)} rows retained)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
