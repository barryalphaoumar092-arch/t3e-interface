const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

const COULEUR_TEXTE = rgb(0, 0, 0);
const CHARS_PAR_PT = 0.55; // estimation largeur moyenne d'un caractère Helvetica

function tronquerLigne(texte, xPx, largeurPage, fontSize) {
  const largeurDispo = largeurPage - xPx - 4;
  const maxChars = Math.max(10, Math.floor(largeurDispo / (fontSize * CHARS_PAR_PT)));
  return texte.length > maxChars ? texte.substring(0, maxChars) : texte;
}

async function fillTemplatePdf(templateBuffer, positions) {
  const pdfDoc = await PDFDocument.load(templateBuffer, { ignoreEncryption: true });
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

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

    const lignes = val.includes('\n') ? val.split('\n') : [val];
    lignes.forEach(function(ligne, i) {
      const ligneTronquee = tronquerLigne(ligne, x, width, fontSize);
      if (!ligneTronquee) return;
      page.drawText(ligneTronquee, {
        x, y: y - (i * (fontSize + 2)),
        size: fontSize, font, color: COULEUR_TEXTE,
      });
    });
  });

  return pdfDoc;
}

module.exports = { fillTemplatePdf };
