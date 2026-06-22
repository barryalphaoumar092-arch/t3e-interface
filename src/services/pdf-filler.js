const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

async function fillTemplatePdf(templateBuffer, projet, materiaux, devisTexte, fichesSelectionnees) {
  const pdfDoc = await PDFDocument.load(templateBuffer, { ignoreEncryption: true });
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const bleu = rgb(0, 0, 0.6);

  const pages = pdfDoc.getPages();
  if (pages.length === 0) return pdfDoc;
  const page = pages[0];

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

  // Coordonnées Y mesurées depuis la grille de calibration (y=0 en bas)

  // ===== EN-TÊTE PROJET =====
  w(projet.client || '', 165, 665);              // NOM DU PROJET
  w(projet.numero || '', 175, 651);              // NUMÉRO DU PROJET

  // ===== ENTREPRENEUR =====
  w('Toitures Trois Étoiles', 100, 615);         // NOM
  w('Couvreur', 410, 615);                       // SPÉCIALITÉ
  w(projet.adresse || '', 125, 588);             // ADRESSE

  // ===== IDENTIFICATION - CHECKBOXES =====
  w('X', 251, 500, { size: 10, font: fontBold });   // Fiche technique ☑

  // Ligne numéro
  w('1', 500, 537);                               // Ligne numéro (ligne Dessin d'atelier)

  // ===== CHAMPS =====
  w(mat.nom || '', 110, 488, { size: 9 });        // Titre
  w(numDessin || '', 185, 470, { size: 8 });      // Numéro de dessins
  w(nbFeuilles, 385, 470, { size: 8 });           // Nombre feuilles
  w(revision || '', 510, 470, { size: 8 });       // Révision
  w(desc || '', 145, 455, { size: 8 });           // Description
  w(mat.fabricant || '', 150, 438);               // Fournisseur
  w(mat.fabricant || '', 360, 438);               // Fabricant

  // ===== TEL QUE PLANS / EQUIVALENCE =====
  w('X', 251, 420, { size: 10, font: fontBold });   // Tel que plans et devis ☑
  w(sectionItem || '', 395, 420, { size: 8 });    // Section (item)
  w(article || '', 355, 402, { size: 8 });        // Article
  w(delai || '', 110, 388, { size: 8 });          // Délai

  // ===== REMARQUE =====
  const remarque = buildRemarque(materiaux, fichesSelectionnees);
  w(remarque, 145, 360, { size: 7 });

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
