# Chattahoochee Watch

A live, one-page dashboard for **West Point Lake** and the **Chattahoochee River** from
Buford Dam and Atlanta down to LaGrange and West Point, Georgia.

Water levels, streamflow, water quality, weather, live cameras and rainfall climatology
in a single view — no account, no API key, no backend server.

## What it shows

| Tab | Contents |
|---|---|
| **Lake Now** | West Point Lake pool elevation against the seasonal guide curve, 24-hour and 7-day change, storage, the inflow/outflow water budget, and upstream Lake Lanier storage. |
| **The Dam** | A live cross-section of West Point Dam drawn to true elevations. Pool and tailwater are gauged on the same datum, so the ~70 ft of head across the structure is real; the lake sits against the flood pool, summer full, seasonal guide curve and minimum lines; and the jet leaving the powerhouse animates at the release the dam is actually making, with a generating / off-peak badge inferred from the day's own range. Below it: pool, head, storage and net balance; a cutaway of one generating unit that follows the water from the trash rack through the penstock, scroll case, Francis runner and draft tube to the tailrace, with units running, net head, estimated megawatts and estimated energy over the last 24 hours; inflow versus release at full instantaneous resolution, labelled by date and hour with a marker at each midnight so the hydropower pulses can be read against the clock; and a bar strip of the actual release at every hour for the last three days, with the generating runs and their real peaks called out. |
| **River water flow** | A pan-and-zoom Leaflet map of the corridor — the same map component as Water Quality, with switchable street, dark and satellite basemaps — with every active gauge plotted in place. Each pin is labelled with its live reading and a ▲/▼ 24-hour trend arrow, so you can read the whole river without clicking anything. Switch between streamflow, stage/pool, water temperature and water quality; markers recolor and resize, and clicking one opens every reading that gauge reports. Below it, the same gauges as a downstream-ordered table plus a 7-day daily-average streamflow bar chart. |
| **Water Quality** | Built around a pan-and-zoom map of every Chattahoochee Riverkeeper sampling site, coloured by its latest lab-cultured E. coli result — switchable between the West Point Lake reach and the whole corridor, with clustered markers that carry the worst result they contain. Below it: live USGS BacteriALERT estimates at Atlanta and Norcross against the 235 cfu/100 mL contact-recreation threshold, the same Riverkeeper samples as tables, plus turbidity, dissolved oxygen and pH. |
| **Weather** | Current conditions, the NWS 7-day forecast for LaGrange, a 10-day rain outlook, 7-day basin rainfall totals, and on-the-water station readings. |
| **Cameras** | USGS streamgage cameras pointed at the water itself (Helen, Columbus, and basin tributaries), plus GDOT / 511GA roadway cameras at Chattahoochee crossings. |
| **Rain vs Normal** | This year's rainfall at LaGrange compared month by month against the 2015–2025 baseline. |

## How it works

The page is entirely static. All live values are fetched **client-side, in the browser**,
from public, keyless, CORS-enabled APIs, so the dashboard is current every time it loads
rather than being as stale as the last build.

| Source | Used for | Refresh |
|---|---|---|
| [USGS Water Services](https://waterservices.usgs.gov/) | Lake elevation, storage, streamflow, stage, water temperature, dissolved oxygen, pH, conductance, turbidity, E. coli | every 15 min in-page |
| [NWS / api.weather.gov](https://api.weather.gov/) | 7-day narrative forecast | every 15 min in-page |
| [Open-Meteo](https://open-meteo.com/) | Current conditions, 10-day rain outlook, ERA5 rainfall history | every 15 min in-page |
| [511GA / GDOT](https://511ga.org/map) | Traffic camera stills | every 60 s while visible |
| [USGS NIMS / HIVIS](https://apps.usgs.gov/hivis/) | River camera stills at streamgages | camera shoots every 15 min in daylight |
| [Chattahoochee Riverkeeper](https://chattahoochee.org/) — [Neighborhood Water Watch](https://nww.chattahoochee.org/) and Swim Guide | Lab-cultured E. coli, turbidity and conductivity at ~190 volunteer sampling sites, and the summer Swim Guide advisory | weekly sampling; mirrored twice daily |
| [OpenStreetMap](https://www.openstreetmap.org/copyright) via Overpass | River centerline and lake shorelines for the interactive map | static, regenerated on demand |

Three scheduled jobs keep the derived data fresh:

- `scripts/build_climatology.py` rebuilds `data/rain-climatology.json`, the LaGrange rainfall
  baseline, from the full ERA5 record.
- `scripts/build_crk.py` rebuilds `data/crk.json` from Chattahoochee Riverkeeper's public
  Neighborhood Water Watch database and Swim Guide layer. Both are CORS-open and could be read
  straight from the browser, but the site tree is ~380 KB and every station needs its own
  follow-up request. Sampling is weekly, so resolving it here and shipping one ~130 KB file is
  faster for visitors and survives CRK ever tightening their database rules.
- `scripts/snapshot.py` appends one row per day to `data/history/daily.json`, preserving
  readings beyond the short window USGS serves.

All three run twice daily via `.github/workflows/update.yml`, which commits any changes and
redeploys the site to GitHub Pages.

`scripts/build_geo.py` is run manually, not on a schedule. It queries the Overpass API for the
Chattahoochee centerline and the West Point Lake and Lake Lanier shorelines, stitches the
unordered OSM multipolygon members into closed rings, simplifies them, and writes
`data/geo.json` (~79 KB). The geometry does not change, so there is no reason to hammer
Overpass on a cron.

## Running locally

```bash
python scripts/build_climatology.py   # optional: refresh the rainfall baseline
python -m http.server 8000
# open http://localhost:8000
```

No build step. The scripts need nothing beyond the Python standard library. The front-end
dependencies are [Leaflet](https://leafletjs.com) 1.9.4 (BSD-2-Clause) and
[Leaflet.markercluster](https://github.com/Leaflet/Leaflet.markercluster) 1.5.3 (MIT),
vendored into `vendor/` so the site never depends on a CDN staying up.
Map tiles come from CARTO and Esri and are fetched by the visitor's browser.

## Gauges used

| USGS site | Location |
|---|---|
| 02334400 | Lake Sidney Lanier near Buford |
| 02334430 | Chattahoochee River at Buford Dam |
| 02335000 | Chattahoochee River near Norcross |
| 02335450 | Chattahoochee River above Roswell |
| 02335815 | Chattahoochee River below Morgan Falls Dam |
| 02336000 | Chattahoochee River at Atlanta |
| 02336490 | Chattahoochee River at GA 280 near Atlanta |
| 02337170 | Chattahoochee River near Fairburn |
| 02338000 | Chattahoochee River near Whitesburg |
| 02338500 | Chattahoochee River at Franklin — West Point Lake inflow |
| 02339400 | West Point Lake near West Point |
| 02339402 | Chattahoochee River below West Point Dam |
| 02339500 | Chattahoochee River at West Point |

## Caveats

- Powerhouse output on the Dam tab is **estimated, not metered**. Neither USACE nor SEPA
  publishes live megawatts for West Point, so the figure is calculated from gauged release and
  gauged head (`kW ≈ 0.0846 × cfs × ft × 0.88`), capped at the plant's two-unit hydraulic
  capacity, and units-running is inferred from flow rather than reported. Nameplate is 73.4 MW
  across two Francis units. Expect it to be in the right neighbourhood, not exact.
- The generating runs on the hour-by-hour chart are read straight from the gauge — a reading is
  counted as "generating" when it sits in the upper part of the three-day range. Nothing on that
  chart is averaged, but it is still a record of what happened, never a schedule of what will.

- USGS instantaneous values are **provisional** and subject to revision. Sensors drift, foul
  and fail; trust trends over any single reading.
- The West Point Lake guide curve drawn on the elevation chart is **approximate and
  reconstructed** for reference. It is not an official USACE operating curve — consult the
  [Mobile District](https://water.sam.usace.army.mil/) for actual lake operations.
- BacteriALERT E. coli figures are **continuous model estimates** derived from turbidity and
  flow, not laboratory culture results. Riverkeeper's Neighborhood Water Watch numbers on the
  Water Quality tab *are* laboratory results, but they are **weekly grab samples** — each one
  describes a single spot at a single moment, and bacteria spike for a day or two after heavy
  rain. A value shown as `<50` means nothing was detected; 50 MPN/100 mL is CRK's reporting
  floor, not a measurement. Neighborhood Water Watch is a volunteer programme and CRK does not
  submit it to EPA's Water Quality Portal, so treat it as advisory rather than regulatory.
- The rainfall baseline is 11 years. The WMO uses 30 years for climate normals, so treat
  anomalies within about one standard deviation as ordinary weather variability.
- **West Point is a peaking hydropower dam.** Its release swings from a few hundred cfs
  overnight to roughly 9,000 cfs while generating, so the water budget uses **24-hour mean**
  flows, not instantaneous readings. An instantaneous outflow taken at the wrong hour will
  invert the apparent sign of the lake's water balance. The budget is cross-checked against
  the reservoir's own reported storage change as an independent measure.
- Cameras: the **USGS river cameras** shoot every 15 minutes in daylight only, so overnight
  frames are dark and timestamped hours behind. The **GDOT roadway cameras** are traffic
  cameras, not scenic river cams, and individual cameras frequently return an
  "image unavailable" placeholder.
- **Nothing here is an official advisory.** For flood, navigation or public-health decisions,
  use NWS, USACE and Georgia EPD directly.

## License

MIT for the code in this repository. `vendor/leaflet/` is Leaflet 1.9.4, BSD-2-Clause,
included verbatim with its licence. The underlying data is public domain (USGS, NOAA) or
belongs to its respective provider (GDOT, Open-Meteo, Chattahoochee Riverkeeper,
OpenStreetMap contributors, CARTO, Esri).
