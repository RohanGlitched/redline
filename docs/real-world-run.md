# Redline on real drawings

Everything in [the benchmark](../bench/README.md) is built by us: we planted the edits, so we know where they are. This run uses drawings nobody prepared for Redline: 7 published drawings from 5 SparkFun open-hardware repositories, every version kept in their GitHub history. The commit message on each new version plays the part of the change notes, written by the engineers who made the change.

![A jumper added in series with the log button, under a commit message about mounting holes](real-world/gnssdo-jumper-added.png)

## What we ran

- **Drawings:** 7 PDF drawings from 5 repositories: the GNSSDO main board, GNSSDO Plus and GNSSDO dimensions drawings (`SparkFun_GNSSDO`), and the schematics of `SparkFun_GNSS_Flex_Breakout`, `SparkFun_IM19_IMU_Breakout`, `SparkFun_GNSS_mosaic-G5_P3` and `SparkFun_Thing_Plus_RA6M5`.
- **Revision pairs:** every consecutive pair of versions in git history: **27 pairs, 118 sheet pairs**, dated December 2023 to November 2025.
- **Engine:** the same comparison code the app ships, with the same thresholds. The harness renders each PDF with PyMuPDF straight to 150 dpi, where the app renders with pdf.js at 300 dpi and halves it; both compare at 150 dpi. The run's totals and every revision pair (commits, dates, sheets, clouds, set-aside, moves) are in [`real-world/run-summary.json`](real-world/run-summary.json). Scripts are in [`bench/real/`](../bench/real/); anyone can clone the repositories and run them again.

## What it found

Redline drew **365 clouds** over the 27 pairs (118 sheet pairs). Three pairs produced none, and in all three the commit message describes a change that is not on the schematic (a 3D model, PCB silk, a file rename).

To check what the clouds mean, we classified **every one of the 365** from before-and-after crops of each (`bench/real/cloud_sheets.py` draws them; the result, one row per cloud with what changed and whether the commit message says so, is [`real-world/clouds.csv`](real-world/clouds.csv)):

| What the cloud marks | Clouds |
|---|---|
| A content change | **195** |
| of which: a part, connection, value or note changed (a jumper, test point, connector pin, regulator block, net renamed, resistor value) | 87 |
| of which: rating text a symbol-library refresh added to parts ("25V 20%") | 55 |
| of which: a net label's drawn shape (signal direction) or a no-connect mark | 53 |
| Content laid out again: blocks and labels moved, otherwise the same | 98 |
| A frame or title-block line redrawn or retitled | 25 |
| Plot stamp from re-exporting: date, time, file path, KiCad version | 25 |
| No real difference | 7 |
| Could not tell from the crop (mostly one sheet re-plotted with a new layout) | 15 |

**Of the 87 changes to parts, connections, values or notes, the commit messages clearly describe 4.** 48 are clearly not in their message, and for 35 the message is too vague to tell ("Final tweaks", "Updates after review", "Update to latest SparkFun KiCad Libraries"). Per release, which is how a checker meets them: **in 10 of the 21 revision pairs with such changes, the message clearly misses at least one, and in none does it clearly describe them all.** The GNSSDO Plus drawing repeats some of the GNSSDO's sheets; counting each repeat described the same way once leaves 74 changes, still with 4 clearly described. Some are exactly the kind of change Redline exists to catch:

- under "Add mounting holes for SiT5811 / Rakon oscillator": a new jumper **JP1** in series with the log button and a new test point **TP1** on the 3.3 V rail (figure above);
- under "Update logo symbol and footprint": a new **3.3 V analog regulator block** (U25 with its capacitors and a test point), and **R8, the resistor the board reads to tell which oscillator is fitted, changed from 1k to 2k**;
- under "Change KiCad file name to SparkPNT_GPSDO": **seven new test points** on the J9 screw terminal;
- under "Routed and panelized": connector J13 reassigned from a UART with flow control to UART plus I²C, and the **common-mode filter removed from the USB data lines**;
- under "Updates after proto review": connectors **J5 and J13 trade places**, connector J4 gains a 19th pin, VBATT is renamed **VBACKUP** (figure below).

![Connectors J5 and J13 swap places under a commit message that says "Updates after proto review"](real-world/flex-connectors-swapped.png)

This is not a criticism of SparkFun's engineers: these are working commits in an open design, not released change orders, and commit messages are not meant to be complete. It shows how easily a revision carries more than its notes say, which is the gap a release gate has to close.

How to read these numbers: the GNSSDO Plus drawing shares sheets with the GNSSDO, so some changes appear twice, once in each history; the classification is our own reading of each crop, published cloud by cloud so anyone can check it; and a commit message is a weaker record than a change order, which is why we report only what it clearly does or does not say.

## What the real drawings taught us

Our own benchmark never re-exports a PDF; real projects do every time. Two changes to the engine came straight from this run:

1. **Re-plot shifts.** A re-exported PDF can nudge line work by a pixel or two. Redline now matches each cloud's before and after patches within about 0.7 mm, and every separate piece of ink inside the cloud on its own too, so one changed digit inside a nudged block keeps the cloud. Clouds that pass are set aside, not deleted: the app lists them under "Set aside", draws them on the sheet on request, and a reviewer can count any one back in as a change. On this run 30 of 395 clouds were set aside. We looked at all 30 side by side ([`real-world/set-aside-all.png`](real-world/set-aside-all.png), made by `bench/real/aside_sheet.py`): every one reads the same before and after. The check is deliberately cautious: small dots of ink (a decimal point, a minus sign) are always checked on their own, so two clouds where a wire was redrawn in place stay as changes rather than risk setting aside a real edit. On the planted benchmark the check cut false clouds from 0.11 to 0.01 per sheet and still found 431 of 432 edits.
2. **Moves and housekeeping.** Redline now measures moves: when the ink that disappeared reappears nearby with the same shape, the change says so, with the distance (the sample bracket's hole reads "Moved 3 mm right and down", exactly as planted; on this run, 72 of the 365 clouds measured as moves). Two kinds of difference are grouped as housekeeping: plot stamps (both texts nothing but dates, times, file paths and tool versions) and labels that moved without changing. Both need at least 90% of the changed ink to be text, so a hole that moved with its callout stays in the main list with its distance. A reviewer opens the group, looks it over, and signs the open ones together; nothing already sent back or declared is touched.

## Limits

- These are electronics schematics, not mechanical drawings. They exercise the same engine, but we have not found a public mechanical drawing with a revision history to run.
- Most of these PDFs were exported without a text layer, so the value check had little to read; the pixel comparison carried the run.
- The classification above is our own reading of each cloud; `bench/real/sheets.py` regenerates the side-by-side crops so others can check it.

Drawings © SparkFun Electronics, published under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) in the repositories named above. The figures on this page are cropped from them and annotated by us (red frames, captions); as adaptations they are shared under the same licence, CC BY-SA 4.0. The rest of this repository is under its own licence.
