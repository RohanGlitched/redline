# Third-party notices

Redline is MIT licensed (see `LICENSE`). It ships or depends on the following open-source work.

| Component | Used for | Licence |
|---|---|---|
| [pdf.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) | drawing PDFs in the light table and reading their text | Apache License 2.0 |
| [React](https://react.dev) and React DOM | the light table, panel and gadget | MIT |
| [@forge/api](https://www.npmjs.com/package/@forge/api), [@forge/bridge](https://www.npmjs.com/package/@forge/bridge), [@forge/kvs](https://www.npmjs.com/package/@forge/kvs), [@forge/resolver](https://www.npmjs.com/package/@forge/resolver) | the Forge runtime | Atlassian's licence for each package |
| iframe-resizer (pulled in by @forge/bridge) | sizing the app's frame inside Jira | MIT |
| tslib (pulled in by the Forge packages) | runtime helpers | 0BSD |
| The fonts in `static/lighttable/src/fonts/` | type in the app | SIL Open Font License 1.1 (`OFL.txt` next to the fonts) |

## Data and figures

- Benchmark drawings: the NIST MBE PMI test cases, a work of the US government and in the public domain. They are downloaded by the benchmark, not shipped.
- Real-world figures in `docs/real-world/`: crops of schematics from SparkFun Electronics' open-hardware repositories, licensed CC BY-SA 4.0. The figures are cropped and annotated by us; the same licence applies to them.
- The sample drawings in `static/lighttable/public/samples/` are NIST public-domain test drawings (CTC 1 and CTC 2) edited by us; the phone photo of a marked-up print is simulated.
- PyMuPDF (AGPL-3.0), OpenCV (Apache-2.0) and NumPy (BSD-3-Clause) are used by the scripts in `bench/` and `tools/`; they are installed by whoever runs them and are not shipped with the app.
