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

  // Construire des descriptions détaillées
  const descParts = [];
  if (mat.type_produit) descParts.push(mat.type_produit);
  if (mat.type_systeme) descParts.push('Système: ' + mat.type_systeme);
  if (mat.dimension) descParts.push('Dim: ' + mat.dimension);
  if (mat.unite) descParts.push(mat.unite);
  if (mat.nom) descParts.push(mat.nom);
  const description = descParts.join(' — ') || mat.nom || '';

  const titreComplet = mat.nom || '';
  const fournisseur = mat.fabricant || mat.fournisseur || '';
  const fabricant = mat.fabricant || '';

  const sectionItem = ext(devisTexte, /section\s*[:#(]?\s*([^\n\r]{1,40})/i);
  const article = ext(devisTexte, /article\s*[:#]?\s*([^\n\r]{1,40})/i);
  const revision = ext(devisTexte, /r[ée]vision\s*[:#]?\s*([^\n\r]{1,20})/i);
  const delai = ext(devisTexte, /d[ée]lai\s*[:#]?\s*([^\n\r]{1,30})/i);
  const numDessin = ext(devisTexte, /(?:dessin|drawing)\s*(?:no|num|#|:)\s*([^\n\r]{1,20})/i);
  const nbFeuilles = fichesSelectionnees && fichesSelectionnees.length > 0 ? String(fichesSelectionnees.length) : '1';

  // Remarque détaillée
  const remarqueParts = [];
  if (fichesSelectionnees && fichesSelectionnees.length > 0) {
    remarqueParts.push('Fiches techniques jointes: ' + fichesSelectionnees.map(f => f.titre + ' (' + (f.source||'') + ')').slice(0,3).join(', '));
  }
  if (materiaux && materiaux.length > 1) {
    remarqueParts.push('Autres materiaux: ' + materiaux.slice(1, 4).map(m => m.nom + ' (' + (m.fabricant||'') + ')').filter(Boolean).join(', '));
  }
  const remarque = remarqueParts.join(' | ').substring(0, 150);

  function w(val, x, y, opts) {
    if (!val) return;
    page.drawText(String(val).substring(0, 80), {
      x, y, size: (opts && opts.size) || 9,
      font: (opts && opts.font) || font,
      color: bleu,
    });
  }

  function check(x, y) {
    page.drawRectangle({ x, y, width: 8, height: 8, color: bleu });
  }

  // ===== EN-TÊTE PROJET =====
  w(projet.client || '', 165, 665);                       // NOM DU PROJET
  w(projet.numero || '', 175, 651);                       // NUMÉRO DU PROJET

  // ===== ENTREPRENEUR =====
  w('Toitures Trois Étoiles Inc.', 100, 615);            // NOM
  w('Couvreur — Toitures et étanchéité', 410, 615, { size: 7 }); // SPÉCIALITÉ
  w(projet.adresse || '', 125, 588);                      // ADRESSE

  // ===== IDENTIFICATION - CASES =====
  check(198, 501);                                         // Fiche technique ☑
  w('1', 500, 537);                                        // Ligne numéro

  // ===== CHAMPS DÉTAILLÉS =====
  w(titreComplet, 110, 488);                               // Titre
  w(numDessin || 'N/A', 185, 470, { size: 8 });           // Numéro de dessins
  w(nbFeuilles, 385, 470, { size: 8 });                   // Nombre feuilles
  w(revision || 'N/A', 510, 470, { size: 8 });            // Révision
  w(description, 145, 455, { size: 7 });                   // Description (détaillée)
  w(fournisseur, 150, 438);                                // Fournisseur
  w(fabricant, 360, 438);                                  // Fabricant

  // ===== TEL QUE PLANS / EQUIVALENCE =====
  check(198, 421);                                         // Tel que plans et devis ☑
  w(sectionItem || '', 395, 420, { size: 8 });             // Section (item)
  w(article || '', 355, 402, { size: 8 });                 // Article
  w(delai || '', 110, 388, { size: 8 });                   // Délai

  // ===== REMARQUE =====
  w(remarque, 145, 360, { size: 6 });

  return pdfDoc;
}

function ext(text, regex) {
  if (!text) return '';
  const m = text.match(regex);
  return m ? m[1].trim() : '';
}

module.exports = { fillTemplatePdf };
