#!/usr/bin/env python3
"""
Build data/geo.json — real Chattahoochee geometry for the River Profile map.

Pulls the river centerline and the two major reservoir outlines from
OpenStreetMap via Overpass, stitches the river ways into one ordered
downstream polyline, simplifies them, and writes compact JSON.

Run rarely; the output is committed so the site has no runtime dependency
on Overpass.
"""
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.osm.ch/api/interpreter',
]
OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'geo.json')

# Corridor of interest: Buford Dam down to just below West Point Dam.
BBOX = (32.80, -85.45, 34.30, -83.90)

RIVER_Q = f"""
[out:json][timeout:180];
way["waterway"="river"]["name"="Chattahoochee River"]{BBOX};
out geom;
"""

LAKE_Q = """
[out:json][timeout:180];
(
  relation["natural"="water"]["name"~"West Point Lake"](32.80,-85.45,33.40,-84.90);
  relation["natural"="water"]["name"~"Lanier"](34.00,-84.35,34.60,-83.70);
);
out geom;
"""


def overpass(query, label):
    last = None
    for round_no in range(3):
        for ep in ENDPOINTS:
            try:
                print(f'  {label}: {ep} (round {round_no + 1})')
                data = urllib.parse.urlencode({'data': query}).encode()
                req = urllib.request.Request(
                    ep, data=data,
                    headers={'User-Agent': 'chattahoochee-watch/1.0 (geometry build)'})
                with urllib.request.urlopen(req, timeout=240) as r:
                    return json.load(r)
            except Exception as exc:                      # noqa: BLE001
                last = exc
                print(f'    failed: {exc}', file=sys.stderr)
                time.sleep(20 + round_no * 30)
    raise SystemExit(f'Overpass unavailable for {label}: {last}')


def perp(p, a, b):
    """Perpendicular distance from p to segment a-b in degree space."""
    (py, px), (ay, ax), (by, bx) = p, a, b
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def simplify(pts, tol):
    """Douglas-Peucker."""
    if len(pts) < 3:
        return pts
    dmax, idx = 0.0, 0
    for i in range(1, len(pts) - 1):
        d = perp(pts[i], pts[0], pts[-1])
        if d > dmax:
            dmax, idx = d, i
    if dmax > tol:
        return simplify(pts[:idx + 1], tol)[:-1] + simplify(pts[idx:], tol)
    return [pts[0], pts[-1]]


def hav(a, b):
    R = 6371.0
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp = math.radians(b[0] - a[0])
    dl = math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def stitch(ways):
    """Greedily chain way geometries into one continuous polyline."""
    segs = [[(p['lat'], p['lon']) for p in w['geometry']]
            for w in ways if w.get('geometry')]
    segs = [s for s in segs if len(s) > 1]
    if not segs:
        raise SystemExit('No river geometry returned.')

    # Start from the northernmost endpoint (upstream near Buford).
    segs.sort(key=lambda s: -max(s[0][0], s[-1][0]))
    chain = segs.pop(0)
    if chain[0][0] < chain[-1][0]:
        chain.reverse()

    while segs:
        tail = chain[-1]
        best_i, best_rev, best_d = None, False, 1e9
        for i, s in enumerate(segs):
            d0, d1 = hav(tail, s[0]), hav(tail, s[-1])
            if d0 < best_d:
                best_i, best_rev, best_d = i, False, d0
            if d1 < best_d:
                best_i, best_rev, best_d = i, True, d1
        if best_d > 6.0:        # nothing plausibly connects; stop
            break
        s = segs.pop(best_i)
        if best_rev:
            s.reverse()
        chain.extend(s[1:])
    return chain


def stitch_rings(segments, tol_km=0.35):
    """Chain way segments into closed rings (OSM multipolygons are unordered)."""
    segs = [list(s) for s in segments if len(s) > 1]
    rings_out = []
    while segs:
        ring = segs.pop(0)
        changed = True
        while changed and segs:
            changed = False
            for i, s in enumerate(segs):
                for rev, endpoint in ((False, s[0]), (True, s[-1])):
                    if hav(ring[-1], endpoint) <= tol_km:
                        piece = list(reversed(s)) if rev else s
                        ring.extend(piece[1:])
                        segs.pop(i)
                        changed = True
                        break
                if changed:
                    break
        if len(ring) > 12:
            if hav(ring[0], ring[-1]) > tol_km:
                ring.append(ring[0])          # force closure
            rings_out.append(ring)
    return rings_out


def rings(elements, matcher):
    """Extract and stitch outer rings for water bodies whose name matches."""
    segs = []
    for el in elements:
        nm = el.get('tags', {}).get('name', '')
        if not matcher(nm):
            continue
        if el['type'] == 'way' and el.get('geometry'):
            segs.append([(p['lat'], p['lon']) for p in el['geometry']])
        elif el['type'] == 'relation':
            for m in el.get('members', []):
                if m.get('role') in ('outer', '') and m.get('geometry'):
                    segs.append([(p['lat'], p['lon']) for p in m['geometry']])
    return stitch_rings(segs)


def main():
    print('Fetching river centerline …')
    river_raw = overpass(RIVER_Q, 'river')
    ways = [e for e in river_raw.get('elements', []) if e['type'] == 'way']
    print(f'  {len(ways)} river ways')
    chain = stitch(ways)
    print(f'  stitched {len(chain)} points')
    river = simplify(chain, 0.0016)
    length = sum(hav(river[i], river[i + 1]) for i in range(len(river) - 1))
    print(f'  simplified to {len(river)} points, {length:.0f} km')

    print('Fetching reservoir outlines …')
    lake_raw = overpass(LAKE_Q, 'lakes')
    els = lake_raw.get('elements', [])

    lakes = {}
    for label, key, tol, match in (
        ('West Point Lake', 'westpoint', 0.0009, lambda n: 'West Point Lake' in n),
        ('Lake Lanier', 'lanier', 0.0013, lambda n: 'Lanier' in n),
    ):
        rs = rings(els, match)
        rs.sort(key=len, reverse=True)
        keep = [simplify(r, tol) for r in rs[:2]]
        keep = [r for r in keep if len(r) > 15]
        lakes[key] = keep
        print(f'  {label}: {len(rs)} rings stitched -> {len(keep)} kept, '
              f'{sum(len(r) for r in keep)} points')
        if not keep:
            print(f'    WARNING: no usable outline for {label}', file=sys.stderr)

    doc = {
        'source': 'OpenStreetMap contributors, via Overpass API (ODbL)',
        'generated': time.strftime('%Y-%m-%d'),
        'note': 'Coordinates are [lat, lon], simplified for display.',
        'river': [[round(a, 5), round(b, 5)] for a, b in river],
        'river_km': round(length, 1),
        'lakes': {k: [[[round(a, 5), round(b, 5)] for a, b in r] for r in v]
                  for k, v in lakes.items()},
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(doc, f, separators=(',', ':'))
    size = os.path.getsize(OUT) / 1024
    print(f'Wrote {os.path.abspath(OUT)} ({size:.0f} KB)')


if __name__ == '__main__':
    main()
