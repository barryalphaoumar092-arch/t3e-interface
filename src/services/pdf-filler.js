const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

async function fillTemplatePdf(templateBuffer, projet, materiaux, devisTexte, fichesSelectionnees) {
  const pdfDoc = await PDFDocument.load(templateBuffer, { ignoreEncryption: true });
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const bleu = rgb(0, 0, 0.7);

  const pages = pdfDoc.getPages();
  if (pages.length === 0) return pdfDoc;

  const firstPage = pages[0];
  const { width, height } = firstPage.getSize();

  // Utiliser les matériaux matchés, sinon créer des données depuis les fiches sélectionnées
  let mat = {};
  if (materiaux && materiaux.length > 0) {
    mat = materiaux[0];
  } else if (fichesSelectionnees && fichesSelectionnees.length > 0) {
    const f = fichesSelectionnees[0];
    mat = {
      nom: f.titre || '',
      fabricant: f.source || '',
      type_produit: 'Fiche technique',
    };
  }
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
    { val: buildRemarque(materiaux, fichesSelectionnees), x: 120, y: height - 435, size: 7 },
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

function buildRemarque(materiaux, fichesSelectionnees) {
  const parts = [];
  if (materiaux && materiaux.length > 1) {
    parts.push('Materiaux: ' + materiaux.slice(1, 4).map(m => m.nom).filter(Boolean).join(', '));
  }
  if (fichesSelectionnees && fichesSelectionnees.length > 0) {
    parts.push('FT jointes: ' + fichesSelectionnees.map(f => f.titre).slice(0, 3).join(', '));
  }
  return parts.join(' | ').substring(0, 120);
}

module.exports = { fillTemplatePdf };
