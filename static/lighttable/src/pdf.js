// Render one PDF page to a grayscale raster with pdf.js, entirely in the browser.
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// dpi is a ceiling: large sheets (B to E size) are drawn at whatever resolution keeps the canvas under
// maxPixels, because browsers refuse canvases much past 16 million pixels.
export async function renderPage(bytes, pageNo = 1, dpi = 150, maxPixels = 16e6) {
  const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
  const page = await doc.getPage(Math.min(pageNo, doc.numPages));
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
  return { w: canvas.width, h: canvas.height, data: gray, canvas, pages: doc.numPages, dpi: scale * 72 };
}
