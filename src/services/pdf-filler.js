const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

async function fillTemplatePdf(templateBuffer, projet, materiaux, devisTexte) {
  const pdfDoc = await PDFDocument.load(templateBuffer, { ignoreEncryption: true });
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const bleu = rgb(0, 0, 0.7);

  const pages = pdfDoc.getPages();
  if (pages.length === 0) return pdfDoc;

  const firstPage = pages[0];
  const { width, height } = firstPage.getSize();

  const mat = materiaux && materiaux.length > 0 ? materiaux[0] : {};
  const description = [mat.type_produit, mat.type_systeme, mat.dimension].filter(Boolean).join(' — ');

  const sectionItem = extractFromDevis(devisTexte, /section\s*[:#(]?\s*([^\n\r]{1,40})/i);
  const article = extractFromDevis(devisTexte, /article\s*[:#]?\s*([^\n\r]{1,40})/i);
  const revision = extractFromDevis(devisTexte, /r[ée]vision\s*[:#]?\s*([^\n\r]{1,20})/i);
  const delai = extractFromDevis(devisTexte, /d[ée]lai\s*[:#]?\s*([^\n\r]{1,30})/i);
  const numDessin = extractFromDevis(devisTexte, /(?:dessin|drawing)\s*(?:no|num|#|:)\s*([^\n\r]{1,20})/i);

  // Positions calibrées pour le bordereau T3E (LETTER 612x792)
  // Les Y sont mesurés depuis le BAS de la page
  const fields = [
    // Infos projet
    { val: projet.client || '', x: 200, y: height - 97, size: 10 },
    { val: projet.numero || '', x: 200, y: height - 115, size: 10 },

    // Entrepreneur
    { val: 'Toitures Trois Étoiles', x: 105, y: height - 165, size: 9 },
    { val: 'Couvreur', x: 130, y: height - 182, size: 9 },
    { val: projet.adresse || '', x: 120, y: height - 199, size: 8 },

    // Identification - Cocher "Fiche technique"
    { val: 'X', x: 65, y: height - 273, size: 10, font: fontBold },

    // Ligne numéro
    { val: '1', x: 430, y: height - 249, size: 9 },

    // Titre
    { val: mat.nom || '', x: 100, y: height - 295, size: 9 },

    // Numéro de dessins / Nombre feuilles / Révision
    { val: numDessin || '', x: 155, y: height - 313, size: 8 },
    { val: materiaux ? String(materiaux.length) : '1', x: 340, y: height - 313, size: 8 },
    { val: revision || '', x: 490, y: height - 313, size: 8 },

    // Description
    { val: description || '', x: 120, y: height - 332, size: 8 },

    // Fournisseur / Fabricant
    { val: mat.fabricant || '', x: 120, y: height - 350, size: 9 },
    { val: mat.fabricant || '', x: 370, y: height - 350, size: 9 },

    // Cocher "Tel que plans et devis"
    { val: 'X', x: 65, y: height - 370, size: 10, font: fontBold },

    // Section (item)
    { val: sectionItem || '', x: 400, y: height - 370, size: 8 },

    // Article
    { val: article || '', x: 400, y: height - 390, size: 8 },

    // Délai
    { val: delai || '', x: 100, y: height - 408, size: 8 },

    // Remarque
    { val: buildRemarque(materiaux), x: 120, y: height - 435, size: 7 },
  ];

  for (const f of fields) {
    if (f.val) {
      firstPage.drawText(String(f.val), {
        x: f.x,
        y: f.y,
        size: f.size || 9,
        font: f.font || font,
        color: bleu,
      });
    }
  }

  return pdfDoc;
}

function extractFromDevis(text, regex) {
  if (!text) return '';
  const match = text.match(regex);
  return match ? match[1].trim() : '';
}

function buildRemarque(materiaux) {
  if (!materiaux || materiaux.length <= 1) return '';
  const noms = materiaux.slice(1, 5).map(m => m.nom).filter(Boolean);
  if (noms.length === 0) return '';
  return 'Autres materiaux: ' + noms.join(', ');
}

module.exports = { fillTemplatePdf };
