# Backstory

Pick a point on a map and read the satellite record for that ground. Backstory pulls the real frames
for the coordinate, shows what used to be there, measures what changed and points at where it changed.
When the imagery can't answer something, it says so.

No accounts, no database, no imagery keys. Sentinel-2 and Landsat scenes are fetched for the point you
choose, analysed once, and cached on disk.

## What a report shows

Two dated frames of the same ground, swipeable, with a change layer you can turn on. Below them, four
figures for the selected pair: the share of land that changed, the share that went from open ground to
building, the greenery delta and the open-ground delta.

A pin history answers the narrow question. It classifies a small window at the exact centre of the
scene in every frame, so you get a line like `2002 open ground → 2016 building → 2019 planting → 2025
building` instead of a district average that says nothing about the plot.

Where the sea became land, a strip above the numbers says so with the area it covers. It comes from the same
water mask: pixels that read as open water in 2002 and read as dry ground later, counted only where both
frames were clear. On Palm Jumeirah that is 1.3 km² of the window.

The April 2024 storm gets a card of its own. It reports what stood on the ground in the first clear pass
after 16 April 2024, with the date and how many days passed, plus how low the plot sits against the median
bare ground within 3 km. The elevation is Copernicus DEM at 30 m, reduced block by block to its lowest tenth
so that towers do not read as hills.

A second card gives August surface temperature: this block against the median of the same pass, and against
that pass's planted ground. One afternoon, at the thermal band's 100 m, so it describes a block rather than a
balcony.

There is also the nearest main road, measured from OpenStreetMap geometry rather than eyeballed, and anything
mapped as under construction within 900 m.

Up to four change hotspots come out of connected-component analysis on the change mask. Each one has a
real area in square metres, a centroid, a before/after crop and a stage: built by the later date, or
still bare ground.

The neighbourhood card lists what OpenStreetMap has within an 800 m walk (1600 m for a station) and
adds a momentum line built from the frames: how much land changed per year, and whether the biggest
changed sites are finished or still being worked.

The question box takes a sentence and answers from the measurements, with both frames attached so it
can describe what it sees. It quotes no number that the algorithms didn't produce.

## Run it

```bash
npm install
npm run dev
```

That serves http://localhost:5175.

The analysis pipeline needs Python 3.11 or newer with `rasterio`, `pystac-client`,
`planetary-computer`, `numpy` and `Pillow` (see `requirements.txt`), available as `python` on PATH.

A location you haven't opened before takes 30 to 60 seconds, because it is downloading real imagery.
Repeat visits read the cached JSON and load immediately.

Deep links open straight into a finished report:

```
http://localhost:5175/?lat=25.186&lon=55.27&name=Business%20Bay
```

Add `&y=2002,2016,2019,2025` to reproduce a custom set of years.

### The one secret

The question box uses `GEMINI_API_KEY`. It is read on the server at start, from the environment or
from `.env`, `.env.local`, `../.env`, `../.env.txt`, and it never reaches the browser. Without a key
the app still runs and the question box falls back to deterministic answers.

## How it works

Search or a map click gives a coordinate. `GET /api/analyze` spawns `pipeline/analyze.py`, which
searches two public STAC catalogues, reads only the window it needs out of each cloud-optimised
GeoTIFF, decodes the integer bands to reflectance, masks cloud and shadow per pixel, computes NDVI,
NDWI, NDBI and BSI for every frame, then compares each pair of frames and writes one JSON file plus
its PNGs into `public/sites/`.

The decoding matters more than it sounds. Sentinel-2 arrives as plain digital numbers and dividing by
10000 cancels inside a normalised index. Landsat Collection 2 carries a scale and an offset, and that
offset does not cancel. Comparing raw Landsat integers compressed every index until Gulf water scored
0.09 NDWI and fell under the 0.15 water threshold, which is how a window that is mostly sea reported
1.2% water. Decoded properly the same scene reads 97% water, and that is what makes the reclamation
line possible.

The change mask is split into connected regions with `rasterio.features.shapes`, which is where the
hotspots and their areas come from. Water is dropped from the change count because a marina edge moves
with the tide.

## Routes

| Route | What it does |
|---|---|
| `GET /api/analyze?lat&lon&slug&name&years` | Runs the pipeline for one coordinate and returns its JSON. Cached by slug. |
| `POST /api/ask` | Sends a question, the measured facts and up to two frames to Gemini. Rate limited to 12 requests a minute, answers cached. |
| `GET /api/around?lat&lon&slug` | OpenStreetMap counts, nearest distances, the nearest main road from way geometry and mapped construction works. Cached to `public/sites/around_<slug>.json`. |

## Data

Sentinel-2 L2A comes from Element 84's Earth Search on AWS Open Data. Landsat Collection 2 Level 2,
including its thermal band, comes from the Microsoft Planetary Computer, which hands out anonymous
access. Elevation is Copernicus DEM at 30 m on AWS Open Data. Map tiles are OpenFreeMap, address
search is Nominatim, roads and nearby places are Overpass. All of it is free and none of it needs an
account.

## What it deliberately won't claim

There is no absolute "per cent built" figure, because bare desert and concrete reflect short-wave
infrared too similarly at this resolution and 2002 desert would read as roughly 90% built. Only
movement between two dates is published.

No figure is measured across sensors. 2002 and 2016 are Landsat at 30 m, 2019 and 2025 are Sentinel-2
at 10 m. Mixed pairs are there to look at, and the page says so on the frame.

Noise, street-level air quality, service charges and prices aren't in the product. A satellite cannot
hear, and it cannot read a service charge.

Crime gets a specific refusal. Dubai Police publish annual rates for the whole emirate; no district
figure is openly available, so no district figure is invented.

## Known limits

A cold location takes about a minute. The two demo addresses are cached, so they don't.

Frames before 2017 come from Landsat at 30 m, and the clearest pass of that year usually lands in late
September rather than October. That month of difference is real and is why old and new frames never
produce a measured number together.

The pin window is small: about 15 m. A click that lands 20 m off describes the neighbouring plot.

OpenStreetMap is volunteer data. In a new district an empty row means nobody mapped it yet, and a
mapped construction site has no completion date attached.

The flood card is one observation on one day. Sentinel-2 passes every five days at best and cloud can
block the interesting ones, so the card always prints its date and the delay. A dry reading on 12 May
says nothing about 17 April.

The elevation card describes ground shape, not drainage. It cannot see a pipe, a soakaway or a
kerb, and a plot at the top of a slope still floods when the drain outside it is blocked.

The heat card is surface temperature at 100 m on a single August afternoon. Sand, asphalt and shaded
paving differ by more than one neighbourhood does, so read it as a block against its pass, never as
the temperature of an apartment.

The Overpass lookup is best effort. If it fails, the neighbourhood card is absent and the rest of the
report is unaffected.

## Repo layout

```
pipeline/analyze.py   one coordinate to JSON plus PNGs; the whole analysis
pipeline/build.py     earlier fixed-area batch script, kept for reference
src/App.tsx           landing, search, report, question box
src/MapPicker.tsx     MapLibre picker
vite.config.ts        the three API routes and the model prompt
public/sites/         cached analyses: frames, overlays, crops, JSON
```

## Checks

`npm run build` runs the type check and the production build. The cached data has to survive an audit:
every image and crop path resolves, no pair reports more new building than total change, no frame
reports contradictory ground classes at the same pin. There is no test suite.
