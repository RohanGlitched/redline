// Render one PDF page to a grayscale raster with pdf.js, entirely in the browser.
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// dpi is a ceiling: large sheets (B to E size) are drawn at whatever resolution keeps the canvas under
// maxPixels, because browsers refuse canvases much past 16 million pixels.
export async function renderPage(bytes, pageNo = 1, dpi = 150, maxPixels = 16e6) {
  const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
  if (pageNo > doc.numPages) return { missing: true, pages: doc.numPages };
  const page = await doc.getPage(pageNo);
  const unit = page.getViewport({ scale: 1 });
  const scale = Math.min(dpi / 72, Math.sqrt(maxPixels / (unit.width * unit.height)));
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const gray = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) gray[j] = (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000;
  // Text the CAD exporter kept as text (dimensions, notes, title block), each run with its box on the raster.
  // Drawings whose text was exported as lines simply have none, and Redline compares pixels alone.
  const texts = [];
  for (const it of (await page.getTextContent()).items) {
    if (!it.str || !it.str.trim()) continue;
    const m = pdfjs.Util.transform(vp.transform, it.transform);
    const len = Math.hypot(m[0], m[1]) || 1, w = it.width * scale;
    const dx = (m[0] / len) * w, dy = (m[1] / len) * w; // along the baseline
    const xs = [m[4], m[4] + dx, m[4] + m[2], m[4] + dx + m[2]], ys = [m[5], m[5] + dy, m[5] + m[3], m[5] + dy + m[3]];
    texts.push({ str: it.str, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
  }
  return { w: canvas.width, h: canvas.height, data: gray, canvas, pages: doc.numPages, dpi: scale * 72, texts };
}
