#!/usr/bin/env python3
"""
Build data/crk.json from Chattahoochee Riverkeeper's public data.

Two sources, both keyless and publicly readable:

  1. Neighborhood Water Watch (NWW) — CRK's volunteer weekly sampling programme,
     stored in a public Firebase Realtime Database. These are *laboratory-cultured*
     E. coli counts (Colilert / IDEXX, MPN per 100 mL), which is a stronger
     measurement than the modelled BacteriALERT estimates the dashboard already
     shows from USGS.

  2. Swim Guide — CRK's summer recreation advisory, published as a public
     ArcGIS FeatureServer layer with a pass/fail-style E. coli result per
     access point and a link to the site's Swim Guide page.

The dashboard could read Firebase directly from the browser (it does send
Access-Control-Allow-Origin: *), but the full site tree is ~380 KB and each
station needs its own follow-up request. NWW sampling is weekly, so resolving
it here twice a day and shipping one small file is both faster for visitors
and resilient if CRK ever tightens the database rules.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

FIREBASE = 'https://waterwatch-cb707.firebaseio.com'
SWIMGUIDE = ('https://services5.arcgis.com/7nfQNRJsdyRF0i5q/arcgis/rest/services/'
             'USE_THIS_FOR_SWIM_GUIDE_2026_DATA_ENTRY_view/FeatureServer/0/query')

OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'crk.json')

# Chattahoochee corridor: Helen headwaters down to Columbus / Walter F. George.
LAT_MIN, LAT_MAX = 32.30, 34.85
LON_MIN, LON_MAX = -85.45, -83.40

FRESH_DAYS = 60      # only keep stations sampled this recently
READINGS = 8         # samples kept per station
REQ_PAUSE = 0.06     # be polite to Firebase

UA = {'User-Agent': 'chattahoochee-watch/1.0 (+https://github.com/Ratherbeflying78/chattahoochee-watch)'}


def fetch(url, tries=3):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode('utf-8'))
        except Exception as e:                                  # noqa: BLE001
            if attempt == tries - 1:
                print(f'  ! giving up on {url[:90]}: {e}', file=sys.stderr)
                return None
            time.sleep(1.5 * (attempt + 1))
    return None


def num(v):
    """CRK stores everything as strings; some are blank or non-numeric."""
    if v in (None, '', 'N/A'):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None       # drop NaN


def truthy(v):
    return str(v).strip().lower() in ('true', '1', 'yes')


def pick_sites():
    print('Fetching NWW collection sites…')
    sites = fetch(f'{FIREBASE}/collectionSites.json')
    if not sites:
        return []

    cutoff = (datetime.now(timezone.utc) - timedelta(days=FRESH_DAYS)).strftime('%Y-%m-%d')
    keep = []
    for key, s in sites.items():
        if not isinstance(s, dict):
            continue
        # Private sites expose metadata but their readings return null.
        if truthy(s.get('isPrivate')) or truthy(s.get('archived')):
            continue
        last = str(s.get('lastCollectionDate') or '')
        if last < cutoff:
            continue
        lat, lon = num(s.get('latitude')), num(s.get('longitude'))
        if lat is None or lon is None:
            continue
        if not (LAT_MIN <= lat <= LAT_MAX and LON_MIN <= lon <= LON_MAX):
            continue
        keep.append({
            'key': key,
            'name': (s.get('stationName') or key).strip(),
            'lat': round(lat, 5),
            'lon': round(lon, 5),
            'huc': (s.get('hucName') or '').strip(),
            'partner': (s.get('collectionPartner') or '').strip(),
            'n': int(num(s.get('numSamples')) or 0),
            'last': last,
        })
    keep.sort(key=lambda x: x['name'])
    print(f'  {len(keep)} corridor sites sampled in the last {FRESH_DAYS} days '
          f'(of {len(sites)} total)')
    return keep


def load_readings(site):
    q = urllib.parse.urlencode({'orderBy': '"collectionDate"', 'limitToLast': READINGS})
    rows = fetch(f'{FIREBASE}/reports/{urllib.parse.quote(site["key"])}.json?{q}', tries=2)
    out = []
    if isinstance(rows, dict):
        for r in rows.values():
            if not isinstance(r, dict):
                continue
            d = str(r.get('collectionDate') or '')
            if not d:
                continue
            out.append({
                'd': d,
                'ec': num(r.get('totalEcoli')),
                'tb': num(r.get('turbidity')),
                'sc': num(r.get('specificConductivity')),
                'rn': num(r.get('precipitation')),
            })
    out.sort(key=lambda x: x['d'])
    return out


REGIONS = {
    'AT': 'Atlanta', 'ATL': 'Atlanta',
    'COL': 'Columbus',
    'HW': 'Headwaters & Lanier', 'HL': 'Headwaters & Lanier',
    'MC': 'West Point Lake & Middle Chattahoochee', 'WPL': 'West Point Lake & Middle Chattahoochee',
}
# Downstream order, so the user's own water sorts to the top of its own section.
REGION_ORDER = {'West Point Lake & Middle Chattahoochee': 0, 'Atlanta': 1,
                'Headwaters & Lanier': 2, 'Columbus': 3}


def load_swimguide():
    print('Fetching Swim Guide layer…')
    q = urllib.parse.urlencode({
        'where': '1=1', 'outFields': '*', 'f': 'json',
        'resultRecordCount': 1000, 'returnGeometry': 'false',
    })
    js = fetch(f'{SWIMGUIDE}?{q}', tries=2)
    if not js or 'features' not in js:
        print('  ! Swim Guide layer unavailable', file=sys.stderr)
        return []
    out = []
    for f in js['features']:
        a = f.get('attributes') or {}
        name = (a.get('FIELD_NAME_A') or '').strip()
        ec = num(a.get('E_coli_results'))
        if not name or ec is None:
            continue
        # Collection_Date arrives as epoch ms or an ISO date depending on the view.
        raw = a.get('Collection_Date')
        date = ''
        if isinstance(raw, (int, float)) and raw > 1e11:
            date = datetime.fromtimestamp(raw / 1000, timezone.utc).strftime('%Y-%m-%d')
        elif raw:
            date = str(raw)[:10]
        out.append({
            'name': name,
            'region': REGIONS.get((a.get('FIELD_NAME_B') or '').strip().upper(),
                                  (a.get('FIELD_NAME_B') or '').strip()),
            'lat': num(a.get('FIELD_NAME_G')),
            'lon': num(a.get('FIELD_NAME_F')),
            'ec': ec,
            'date': date,
            'url': (a.get('Website_Link') or '').strip(),
        })
    out.sort(key=lambda x: (REGION_ORDER.get(x['region'], 9), x['name']))
    print(f'  {len(out)} Swim Guide access points')
    return out


def main():
    sites = pick_sites()
    if not sites:
        print('No NWW sites resolved — leaving existing data/crk.json alone.', file=sys.stderr)
        return 1

    print(f'Fetching readings for {len(sites)} sites…')
    kept = []
    for i, s in enumerate(sites, 1):
        s['readings'] = load_readings(s)
        if s['readings']:
            kept.append(s)
        if i % 40 == 0:
            print(f'  {i}/{len(sites)}')
        time.sleep(REQ_PAUSE)

    doc = {
        'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'Chattahoochee Riverkeeper — Neighborhood Water Watch & Swim Guide',
        'nww': kept,
        'swimguide': load_swimguide(),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as fh:
        json.dump(doc, fh, separators=(',', ':'))
    size = os.path.getsize(OUT)
    print(f'Wrote {OUT} — {len(kept)} stations, {len(doc["swimguide"])} swim sites, '
          f'{size/1024:.0f} KB')
    return 0


if __name__ == '__main__':
    sys.exit(main())
