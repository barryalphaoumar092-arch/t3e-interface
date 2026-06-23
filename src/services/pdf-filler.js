const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

async function fillTemplatePdf(templateBuffer, positions) {
  const pdfDoc = await PDFDocument.load(templateBuffer, { ignoreEncryption: true });
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bleu = rgb(0, 0, 0.6);

  const pages = pdfDoc.getPages();
  if (pages.length === 0) return pdfDoc;
  const page = pages[0];
  const { width, height } = page.getSize();

  if (!positions || Object.keys(positions).length === 0) return pdfDoc;

  Object.keys(positions).forEach(function(key) {
    const p = positions[key];
    if (!p || !p.val) return;
    const x = (p.x / 100) * width;
    const y = height - ((p.y / 100) * height);
    page.drawText(String(p.val).substring(0, 80), {
      x, y,
      size: 9,
      font,
      color: bleu,
    });
  });

  return pdfDoc;
}

module.exports = { fillTemplatePdf };
