# Redline benchmark

These scripts measure the comparison engine that ships in the app (`static/lighttable/src/engine/`). Nothing is copied or tuned separately, so a change to the engine shows up here first.

## What is measured

**Drawing revisions.** `gen.py` takes the public-domain NIST MBE PMI test drawings (the combined, fully-toleranced and atomic test cases: 88 vector pages) and plants 1 to 3 edits in each copy at the PDF level:

- move a feature by 1.5 to 4 mm
- resize a feature by 0.75 to 1.3 times
- delete a feature
- add a note or a hole
- change a dimension value

It records the box of every edit, then renders revision A and revision B at 150 dpi. Each page gets four variants, and one of them has no edits, so it measures false clouds on an unchanged sheet. Each revision B also gets a "rescan" variant:

- rotation within ±1.5°
- scale 0.98 to 1.02
- a shift of up to 25 px
- blur and sensor noise
- paper tint
- JPEG quality 45 to 80

`visible.py` drops edits that change no visible ink, such as a zero-area path. Neither a person nor a tool can see those.

**Marked-up prints.** `photos.py` builds 60 simulated phone photos of NIST pages "printed" on warm paper, each with 1 to 4 red-pen markups: circles, clouds, arrows, strike-throughs and handwritten values. Each print lies on a desk at a random perspective, with:

- uneven light and a soft shadow
- blur and noise
- JPEG compression

## Results (engine as shipped, Node 24, one CPU core, measured Nov 1 2026)

| Test | Result |
|---|---|
| Digital revisions, 352 pairs, 432 visible edits | 99.8% of edits found (431 of 432), no false clouds on unchanged sheets, 0.11 false clouds per sheet overall, about 0.4 s per sheet |
| Rescanned revision B, same 352 pairs | 91.7% of edits found (396 of 432), 2.7 false clouds per sheet |
| Photographed prints, 60 photos, 160 pen marks | 160 of 160 marks found, no false marks, sheet found in all 60 photos, about 0.3 s per photo |
| Registration on rescans | median rotation error under 0.01° |

## Run it

You need Python 3.11+ with `pymupdf`, `opencv-python` and `numpy`, and Node 22 or later. Download the NIST test case drawings (CTC, FTC and ATC PDF sets) from the [MBE PMI Validation and Conformance Testing project](https://www.nist.gov/el/systems-integration-division-73400/mbe-pmi-validation-and-conformance-testing-project) into `nist/` (one folder per set, as NIST ships them). Then run:

```bash
python gen.py nist out/bench 4      # pairs per page; writes rasters and index.json with ground truth
python visible.py out/bench         # marks which planted edits change visible ink
node eval.mjs out/bench b           # digital revision B
node eval.mjs out/bench bs          # rescanned revision B
python photos.py nist out/photos 60
node eval_markup.mjs out/photos
```

The generated rasters take about 4 GB, so they are not in the repository. Seeds are fixed, so the same drawings give the same benchmark.

## Known limits

- The rescans and phone photos are simulated. Real scans with folds, coffee stains or a sheet partly out of frame are not covered yet.
- A change smaller than about 25 dark pixels at 150 dpi (roughly a 0.4 mm stroke) is below what the engine reports.
- Two edits within about 7 mm of each other are drawn as one cloud on purpose, the way a drafter would cloud them.
