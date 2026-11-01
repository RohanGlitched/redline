# Redline on real drawings

Everything in [the benchmark](../bench/README.md) is built by us: we planted the edits, so we know where they are. This run uses drawings nobody prepared for Redline: the published schematics of five SparkFun open-hardware boards, every version kept in their GitHub history. The commit message on each new version plays the part of the change notes, written by the engineers who made the change.

![A jumper added in series with the log button, under a commit message about mounting holes](real-world/gnssdo-jumper-added.png)

## What we ran

- **Drawings:** 7 PDF drawings from 5 repositories (`SparkFun_GNSSDO` main board and GNSSDO Plus, `SparkFun_GNSS_Flex_Breakout`, `SparkFun_IM19_IMU_Breakout`, `SparkFun_GNSS_mosaic-G5_P3`, `SparkFun_Thing_Plus_RA6M5`), plus the GNSSDO dimensions drawing.
- **Revision pairs:** every consecutive pair of versions in git history: **27 pairs, 118 sheet pairs**, dated December 2023 to November 2025.
- **Engine:** the same one the app ships, at the same settings. Scripts are in [`bench/real/`](../bench/real/); anyone can clone the repositories and run them again.

## What it found

Redline drew **363 clouds** over the 27 pairs. Three pairs produced none, and in all three the commit message describes a change that is not on the schematic (a 3D model, PCB silk, a file rename).

To check what the clouds mean, we inspected every cloud in 9 pairs (60 clouds) at full zoom, before and after side by side:

| What the cloud marks | Clouds |
|---|---|
| A content change: a part, jumper, test point or pin added, a net or reference renamed, a note added or reworded, a value changed | 25 |
| Content laid out again: blocks and labels moved, otherwise the same | 18 |
| Plot stamp from re-exporting: date, time, file path, KiCad version | 10 |
| A frame or dashed box redrawn | 2 |
| No real difference: line work nudged by a pixel in a re-export | 5 |

**Of the 25 content changes, the commit message describes 3.** The other 22 sit under messages such as "Routed", "Updates after review", "Final tweaks" or "Update to latest SparkFun KiCad Libraries". Some are exactly the kind of change Redline exists to catch:

- under "Add mounting holes for SiT5811 / Rakon oscillator": a new jumper **JP1** in series with the log button, a new test point **TP1** on the 3.3 V rail, and diode references D9 and D10 swapped (figure above);
- under "Updates after proto review": connectors **J5 and J13 trade places**, connector J4 gains a 19th pin, VBATT is renamed **VBACKUP**, and the antenna grounds are isolated (figure below);
- under "Updates after review" on the IM19 board: a jumper relabelled from "Measure JP1" to "MEAS", a net renamed from CH342_EN.1 to CH342_EN, and a new design note on the locking JST connector.

![Connectors J5 and J13 swap places under a commit message that says "Updates after proto review"](real-world/flex-connectors-swapped.png)

This is not a criticism of SparkFun's engineers: these are working commits in an open design, not released change orders, and commit messages are not meant to be complete. It shows how easily a revision carries more than its notes say, which is the gap a release gate has to close.

## What the real drawings taught us

Our own benchmark never re-exports a PDF; real projects do every time. Two changes to the engine came straight from this run:

1. **Re-plot shifts.** A re-exported PDF can nudge line work by a pixel or two. Redline now matches each cloud's before and after patches within about 0.7 mm and sets aside the ones that agree. On this run that removed 32 of 395 clouds, including all 5 with no real difference in the inspected sample (and one label nudged by less than 0.7 mm). On the planted benchmark it removed false clouds (0.11 to 0.01 per sheet) and missed nothing (150 of 150 edits in the subset we reran).
2. **Moves and housekeeping.** Redline now measures moves: when the ink that disappeared reappears nearby with the same shape, the change says so, with the distance (the sample bracket's hole reads "Moved 3 mm right and down", exactly as planted). Plot stamps, and labels that moved without changing where the PDF keeps its text, are grouped as housekeeping that a reviewer can accept and sign in one click; every other move is labelled with its distance, so a reviewer can tell a nudged block from an edit at a glance.

## Limits

- These are electronics schematics, not mechanical drawings. They exercise the same engine, but we have not found a public mechanical drawing with a revision history to run.
- Most of these PDFs were exported without a text layer, so the value check had little to read; the pixel comparison carried the run.
- The classification above is our own reading of each cloud; `bench/real/sheets.py` regenerates the side-by-side crops so others can check it.

Drawings © SparkFun Electronics, published under CC BY-SA 4.0; crops reproduced with attribution.
