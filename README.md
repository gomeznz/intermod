# Intermod

Harmonic and intermodulation calculator for New Zealand radio sites, built on the RSM
**PIB 23 – Mobile Service Bands in New Zealand** (Issue 9.1, April 2019) channel plans.

## What it does

| Tab | Question it answers |
|---|---|
| **Find source** | A receiver is getting hit. Which transmitters (on the site, and/or anywhere in chosen PIB 23 bands) can produce a harmonic or IM product on it? |
| **Check site** | For every transmitter on a site, which harmonics / IM products land on any of the site's receivers? |
| **Clean channel** | Which channel in a band plan can be added to the site without creating, or receiving, a product? |

Products covered (orders set under *Calculation settings*):

- Harmonics `nA` (default up to 10th)
- 2-tone IM `mA ± nB` (default odd orders up to 7th: `2A−B`, `3A−2B`, `4A−3B` …)
- 3-tone IM `aA ± bB ± cC` (default odd orders up to 5th: `A+B−C`, `2A−B−C`, …)
- Even-order mixing (`A+B`, `A−B` …) optional

A product is a **hit** when its occupied bandwidth (Σ|coefficient| × carrier occupied bandwidth)
overlaps the receiver's bandwidth, widened by an optional guard band.

Widths come from each site entry's **emission mode**, not its channel spacing. Defaults by spacing:
6.25 kHz → NXDN (4K00F1E, 4 kHz) since those channels are used for digital modes; 12.5 kHz →
analogue FM (11K0F3E); 25 kHz → 16K0F3E. Per entry you can pick NXDN 12.5 (8K30F1E),
DMR (7K60FXE), P25 Phase 1 (8K10F1E) or a custom width. Results are ranked by order (lower is
stronger), then by how close they land.

Sites are stored in the browser (localStorage) and can be exported/imported as JSON or pasted as a
list (`FN123` per line, or `label, Tx MHz, Rx MHz, bw kHz`).

## Channel data

`data/channels.json` holds 21,353 channels from PIB 23: land mobile (ESA, A, ESB, E, MS, EE, Bush
Winch, TD, C, D, F, ESC, TS, TX), aeronautical, maritime VHF/UHF, PRS repeaters, telecommand,
paging and radio reporter. Each channel has its frequency, spacing (6.25/12.5/25 kHz), role
(base Tx / mobile Tx / simplex), pair and the PIB "use" remark.

Rebuild it from the PDF (needs `pdftotext` from poppler and Python 3):

```sh
npm run build:data
```

Known quirks in the source document: the E band diagram says ENNX1–ENNX188 but the table stops at
ENNX178; the ESA 25 kHz table lists channels on a 12.5 kHz raster.

## Run

No dependencies. Node 18+.

```sh
npm start        # http://localhost:3000  (PORT env var respected)
npm test         # engine tests, incl. brute-force cross-checks
```

The calculations run in the browser (Web Worker), so the server only serves static files.
On Railway: connect the repo, it detects Node and runs `npm start`. Health check: `/healthz`.

## Layout

```
server.js              zero-dependency static server (gzip, ETag)
public/engine.js       harmonic / IM engine (shared by browser and tests)
public/worker.js       runs the engine off the UI thread
public/app.js          UI
data/channels.json     generated channel database
tools/parse_pib23.py   PDF-text -> channels.json parser
sources/               the RSM PIB 23 PDF
test/                  node:test suite
```

## Ideas / next

- Pull licensed transmitters near a site from the RSM Register of Radio Frequencies
- Spectrum allocations (PIB 21) and management-right blocks (PIB 24: cellular, broadcast) as sources
- Receiver image / IF products, Tx noise and desense
