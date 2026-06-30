const mammoth = require('mammoth');
const pdfMake = require('pdfmake');
const htmlToPdfmake = require('html-to-pdfmake');
const { JSDOM } = require('jsdom');

pdfMake.setFonts({
  Helvetica: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique',
  },
});
pdfMake.setUrlAccessPolicy(() => false);
pdfMake.setLocalAccessPolicy(() => true);

// Convertit le .docx REMPLI (sortie de remplirBordereau, contenu réel inchangé)
// en PDF. N'altère pas le remplissage : prend simplement le résultat et le
// rend en PDF via mammoth (extraction du contenu réel) + pdfmake (rendu PDF).
async function convertirDocxEnPdf(docxBuffer) {
  const { value: htmlBrut } = await mammoth.convertToHtml({ buffer: docxBuffer });
  // mammoth génère des ancres id="__Fieldmark__..." pour les champs de formulaire
  // (cases à cocher) du document Word ; ces id peuvent se dupliquer et font
  // planter pdfmake (qui exige des id uniques pour les signets). On ne s'en sert
  // pas dans le PDF final, donc on les retire.
  // La police standard Helvetica de pdfkit (WinAnsi) ne supporte pas ☒/☐
  // (hors Latin-1) : on les remplace par un équivalent ASCII pour le rendu PDF
  // uniquement. Le .docx réel garde le vrai symbole, on ne touche pas au
  // remplissage (bordereau-filler.js).
  const html = htmlBrut
    .replace(/\sid="__Fieldmark[^"]*"/g, '')
    .replace(/☒/g, '[X]')
    .replace(/☐/g, '[ ]');
  const dom = new JSDOM('');
  const content = htmlToPdfmake(html, { window: dom.window });

  const docDefinition = {
    content,
    defaultStyle: { font: 'Helvetica', fontSize: 9 },
    pageSize: 'LETTER',
    pageMargins: [40, 40, 40, 40],
  };

  const pdfDoc = pdfMake.createPdf(docDefinition);
  return pdfDoc.getBuffer();
}

module.exports = { convertirDocxEnPdf };
