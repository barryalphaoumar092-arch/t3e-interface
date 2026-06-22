const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

async function fillTemplatePdf(templateBuffer, projet, materiaux, devisTexte, fichesSelectionnees) {
  const pdfDoc = await PDFDocument.load(templateBuffer, { ignoreEncryption: true });
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const bleu = rgb(0, 0, 0.6);

  const pages = pdfDoc.getPages();
  if (pages.length === 0) return pdfDoc;

  const page = pages[0];
  const H = page.getSize().height;

  let mat = {};
  if (materiaux && materiaux.length > 0) {
    mat = materiaux[0];
  } else if (fichesSelectionnees && fichesSelectionnees.length > 0) {
    const f = fichesSelectionnees[0];
    mat = { nom: f.titre || '', fabricant: f.source || '', type_produit: 'Fiche technique' };
  }

  const desc = [mat.type_produit, mat.type_systeme, mat.dimension].filter(Boolean).join(' — ');
  const sectionItem = ext(devisTexte, /section\s*[:#(]?\s*([^\n\r]{1,40})/i);
  const article = ext(devisTexte, /article\s*[:#]?\s*([^\n\r]{1,40})/i);
  const revision = ext(devisTexte, /r[ée]vision\s*[:#]?\s*([^\n\r]{1,20})/i);
  const delai = ext(devisTexte, /d[ée]lai\s*[:#]?\s*([^\n\r]{1,30})/i);
  const numDessin = ext(devisTexte, /(?:dessin|drawing)\s*(?:no|num|#|:)\s*([^\n\r]{1,20})/i);
  const nbFeuilles = fichesSelectionnees ? String(fichesSelectionnees.length) : '1';

  function w(val, x, y, opts) {
    if (!val) return;
    page.drawText(String(val), {
      x, y, size: (opts && opts.size) || 9,
      font: (opts && opts.font) || font,
      color: bleu,
    });
  }

  // ===== EN-TÊTE PROJET =====
  w(projet.client || '', 150, H - 128);
  w(projet.numero || '', 168, H - 145);

  // ===== ENTREPRENEUR =====
  w('Toitures Trois Étoiles', 88, H - 188);
  w('Couvreur', 375, H - 188);
  w(projet.adresse || '', 112, H - 213);

  // ===== IDENTIFICATION - CHECKBOXES =====
  w('X', 214, H - 318, { size: 10, font: fontBold });   // Fiche technique ☑
  w('1', 488, H - 278, { size: 9 });                     // Ligne numéro

  // ===== CHAMPS IDENTIFICATION =====
  w(mat.nom || '', 105, H - 338, { size: 9 });           // Titre
  w(numDessin || '', 165, H - 357, { size: 8 });         // Numéro de dessins
  w(nbFeuilles, 360, H - 357, { size: 8 });              // Nombre feuilles
  w(revision || '', 468, H - 357, { size: 8 });          // Révision
  w(desc || '', 130, H - 376, { size: 8 });              // Description
  w(mat.fabricant || '', 138, H - 395, { size: 9 });     // Fournisseur
  w(mat.fabricant || '', 332, H - 395, { size: 9 });     // Fabricant

  // ===== TEL QUE PLANS / EQUIVALENCE =====
  w('X', 214, H - 414, { size: 10, font: fontBold });    // Tel que plans et devis ☑
  w(sectionItem || '', 362, H - 414, { size: 8 });       // Section (item)
  w(article || '', 320, H - 434, { size: 8 });           // Article
  w(delai || '', 105, H - 453, { size: 8 });             // Délai

  // ===== REMARQUE =====
  const remarque = buildRemarque(materiaux, fichesSelectionnees);
  w(remarque, 132, H - 480, { size: 7 });

  return pdfDoc;
}

function ext(text, regex) {
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
