const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

async function fillTemplatePdf(templateBuffer, positions) {
  const pdfDoc = await PDFDocument.load(templateBuffer, { ignoreEncryption: true });
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bleu = rgb(0, 0, 0.6);

  const pages = pdfDoc.getPages();
  if (pages.length === 0) return pdfDoc;
  if (!positions || Object.keys(positions).length === 0) return pdfDoc;

  Object.keys(positions).forEach(function(key) {
    const p = positions[key];
    if (!p || !p.val) return;

    const pageIndex = p.page || 0;
    if (pageIndex >= pages.length) return;

    const page = pages[pageIndex];
    const { width, height } = page.getSize();
    const x = (p.x / 100) * width;
    const y = height - ((p.y / 100) * height);
    const fontSize = p.size || 9;
    const val = String(p.val);

    if (val.includes('\n')) {
      val.split('\n').forEach(function(line, i) {
        page.drawText(line.substring(0, 80), {
          x, y: y - (i * (fontSize + 2)),
          size: fontSize, font, color: bleu,
        });
      });
    } else {
      page.drawText(val.substring(0, 80), {
        x, y, size: fontSize, font, color: bleu,
      });
    }
  });

  return pdfDoc;
}

module.exports = { fillTemplatePdf };
