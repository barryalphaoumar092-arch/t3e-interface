const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

async function fillTemplatePdf(templateBuffer, projet, materiaux, devisTexte, fichesSelectionnees) {
  const pdfDoc = await PDFDocument.load(templateBuffer, { ignoreEncryption: true });
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const bleu = rgb(0, 0, 0.6);

  const pages = pdfDoc.getPages();
  if (pages.length === 0) return pdfDoc;

  const page = pages[0];
  const { height } = page.getSize();

  let mat = {};
  if (materiaux && materiaux.length > 0) {
    mat = materiaux[0];
  } else if (fichesSelectionnees && fichesSelectionnees.length > 0) {
    const f = fichesSelectionnees[0];
    mat = { nom: f.titre || '', fabricant: f.source || '', type_produit: 'Fiche technique' };
  }

  const description = [mat.type_produit, mat.type_systeme, mat.dimension].filter(Boolean).join(' — ');
  const sectionItem = extract(devisTexte, /section\s*[:#(]?\s*([^\n\r]{1,40})/i);
  const article = extract(devisTexte, /article\s*[:#]?\s*([^\n\r]{1,40})/i);
  const revision = extract(devisTexte, /r[ée]vision\s*[:#]?\s*([^\n\r]{1,20})/i);
  const delai = extract(devisTexte, /d[ée]lai\s*[:#]?\s*([^\n\r]{1,30})/i);
  const numDessin = extract(devisTexte, /(?:dessin|drawing)\s*(?:no|num|#|:)\s*([^\n\r]{1,20})/i);
  const nbFeuilles = fichesSelectionnees ? String(fichesSelectionnees.length) : '1';

  function w(val, x, y, opts) {
    if (!val) return;
    page.drawText(String(val), {
      x, y, size: (opts && opts.size) || 9,
      font: (opts && opts.font) || font,
      color: bleu,
    });
  }

  // === NOM DU PROJET / NUMÉRO DU PROJET ===
  w(projet.client || projet.numero || '', 148, height - 143);
  w(projet.numero || '', 165, height - 158);

  // === IDENTIFICATION DE L'ENTREPRENEUR ===
  w('Toitures Trois Étoiles', 90, height - 195);
  w('Couvreur', 385, height - 195);
  w(projet.adresse || '', 115, height - 222);

  // === IDENTIFICATION - Checkboxes ===
  // Cocher "Fiche technique" (3ème checkbox)
  w('X', 213, height - 365, { size: 11, font: fontBold });

  // Ligne numéro
  w('1', 490, height - 325, { size: 10 });

  // Titre
  w(mat.nom || '', 108, height - 393, { size: 10 });

  // Numéro de dessins / Nombre feuilles / Révision
  w(numDessin || '', 168, height - 417);
  w(nbFeuilles, 362, height - 417);
  w(revision || '', 468, height - 417);

  // Description
  w(description || '', 133, height - 441, { size: 8 });

  // Fournisseur / Fabricant
  w(mat.fabricant || '', 140, height - 461);
  w(mat.fabricant || '', 335, height - 461);

  // Cocher "Tel que plans et devis"
  w('X', 213, height - 481, { size: 11, font: fontBold });

  // Section (item)
  w(sectionItem || '', 365, height - 481);

  // Article
  w(article || '', 325, height - 501);

  // Délai
  w(delai || '', 108, height - 521);

  // Remarque
  const remarque = buildRemarque(materiaux, fichesSelectionnees);
  w(remarque, 135, height - 552, { size: 7 });

  return pdfDoc;
}

function extract(text, regex) {
  if (!text) return '';
  const m = text.match(regex);
  return m ? m[1].trim() : '';
}

function buildRemarque(materiaux, fichesSelectionnees) {
  const parts = [];
  if (materiaux && materiaux.length > 1) {
    parts.push('Autres: ' + materiaux.slice(1, 4).map(m => m.nom).filter(Boolean).join(', '));
  }
  if (fichesSelectionnees && fichesSelectionnees.length > 0) {
    parts.push('FT: ' + fichesSelectionnees.map(f => f.titre).slice(0, 3).join(', '));
  }
  return parts.join(' | ').substring(0, 130);
}

module.exports = { fillTemplatePdf };
