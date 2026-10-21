// Runs inside a hidden window: draws page 1 of a PDF onto a canvas and hands back a JPEG.
// Chromium already knows how to draw, so no native add-ons are needed on any platform.
import * as pdfjs from '../../node_modules/pdfjs-dist/build/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href;

window.slothPdf.onRender(async ({ id, bytes, maxSide }) => {
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, maxSide / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    const url = canvas.toDataURL('image/jpeg', 0.82);
    window.slothPdf.done({ id, image: url.slice(url.indexOf(',') + 1), width: canvas.width, height: canvas.height });
  } catch (e) {
    window.slothPdf.done({ id, error: String((e && e.message) || e) });
  } finally {
    if (doc) doc.destroy();
  }
});
window.slothPdf.ready();
