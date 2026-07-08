// Remplissage des formulaires de soumission SEAO — contrairement aux
// bordereaux/manuels (gabarits T3E connus à l'avance), un formulaire SEAO est
// un document TIERS de structure totalement inconnue (varie d'un donneur
// d'ouvrage à l'autre). Il n'y a donc pas de liste de libellés à essayer en
// premier : on part directement du fallback IA générique
// (placerChampsRestantsViaIA), qui fonctionne sur le texte réellement présent
// dans CE document plutôt que sur une liste fixe.
const JSZip = require('jszip');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { normalizeXmlText, placerChampsRestantsViaIA } = require('./docx-xml-utils');
const { mapperChampsFormulairePdf, mapperChampsBordereau } = require('./claude-client');

const NOMS_LISIBLES = {
  NEQ: 'NEQ', RBQ: 'Numéro de licence RBQ', NOM_ENTREPRISE: "Nom de l'entreprise",
  ADRESSE_ENTREPRISE: 'Adresse', TELEPHONE_ENTREPRISE: 'Téléphone',
  ASSURANCE_RESPONSABILITE_CIVILE: 'Assurance responsabilité civile',
  ASSURANCE_AUTOMOBILE: 'Assurance automobile', CAUTIONNEMENT: 'Cautionnement',
  SIGNATAIRE_AUTORISE: 'Signataire autorisé', CERTIFICATIONS: 'Certifications',
};

function aplatirInfosEntreprise(infosEntreprise) {
  const champs = {};
  for (const [cle, valeur] of Object.entries(infosEntreprise || {})) {
    if (cle === 'confiance' || cle === 'error') continue;
    if (cle === 'CERTIFICATIONS') {
      if (Array.isArray(valeur) && valeur.length > 0) champs.CERTIFICATIONS = valeur.join(', ');
      continue;
    }
    if (valeur) champs[cle] = valeur;
  }
  return champs;
}

// .docx — réutilise le moteur partagé docx-xml-utils.js en mode "tout en
// fallback IA" (pas de libellé connu à essayer avant).
// NOTE : contrairement à remplirBordereau()/remplirManuel(), on n'appelle PAS
// ajouterChampsNonPlaces() ici — coller un paragraphe "Renseignements
// complémentaires" sur un formulaire officiel destiné à un donneur d'ouvrage
// public serait inapproprié. Les champs non placés sont retournés à
// l'appelant pour être présentés à l'utilisateur (saisie manuelle assistée),
// jamais insérés silencieusement dans le document final.
async function remplirFormulaireDocx(buf, infosEntreprise) {
  const zip = await JSZip.loadAsync(buf);
  const fichierXml = zip.file('word/document.xml');
  if (!fichierXml) throw new Error('Document .docx invalide (word/document.xml introuvable).');
  let xml = await fichierXml.async('string');
  xml = normalizeXmlText(xml);

  const champs = aplatirInfosEntreprise(infosEntreprise);
  const resultat = await placerChampsRestantsViaIA(xml, champs);
  xml = resultat.xml;

  zip.file('word/document.xml', xml);
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });

  return {
    buffer,
    champsPlaces: Object.keys(champs).filter((c) => !(c in resultat.restants)),
    champsNonPlaces: Object.keys(resultat.restants).map((c) => NOMS_LISIBLES[c] || c),
  };
}

// PDF avec champs AcroForm réels — première utilisation de pdf-lib.getForm()
// dans ce repo. Liste les champs, demande à l'IA quelle valeur correspond à
// quel champ (par nom technique, généralement déjà sémantique dans un
// formulaire officiel), remplit, puis APLATIT (flatten) pour figer le rendu
// (évite qu'un futur logiciel PDF affiche des champs vides par-dessus le texte).
async function remplirFormulairePdfAcroForm(buf, infosEntreprise) {
  const pdfDoc = await PDFDocument.load(buf);
  const form = pdfDoc.getForm();
  const champsForm = form.getFields();
  if (champsForm.length === 0) {
    throw new Error('Aucun champ de formulaire (AcroForm) trouvé dans ce PDF — probablement un PDF plat/scanné.');
  }

  const noms = champsForm.map((c) => c.getName());
  const donnees = aplatirInfosEntreprise(infosEntreprise);
  const mapping = await mapperChampsFormulairePdf(noms, donnees);

  const champsPlaces = [];
  const champsNonPlaces = [];
  for (const champ of champsForm) {
    const nom = champ.getName();
    const valeur = mapping ? mapping[nom] : null;
    if (!valeur) { champsNonPlaces.push(nom); continue; }
    try {
      if (typeof champ.setText === 'function') {
        champ.setText(String(valeur));
        champsPlaces.push(nom);
      } else if (typeof champ.check === 'function') {
        // Case a cocher : on ne coche que sur une valeur explicitement positive
        if (/^(oui|yes|true|1|x)$/i.test(String(valeur).trim())) { champ.check(); champsPlaces.push(nom); }
        else champsNonPlaces.push(nom);
      } else {
        champsNonPlaces.push(nom);
      }
    } catch (e) {
      console.error('[seao-formulaire] Champ PDF non rempli:', nom, e.message);
      champsNonPlaces.push(nom);
    }
  }

  // NE PAS flatten() ici : l'utilisateur doit pouvoir valider/corriger les
  // champs (prix, exclusions...) dans son propre lecteur PDF avant dépôt —
  // l'aplatissement final se fera (si souhaité) au moment du "Générer le PDF".
  const buffer = Buffer.from(await pdfDoc.save());
  return { buffer, champsPlaces, champsNonPlaces };
}

// PDF plat (sans champs AcroForm) — cas le plus dur, traité en best-effort
// EXPLICITE : extrait le texte par ligne AVEC sa position (x, y) sur chaque
// page (pdf-parse avec un pagerender custom, même principe que texteParPage()
// dans document-parser.js mais en conservant la géométrie), réutilise
// mapperChampsBordereau() (même fonction IA que pour les .docx — son schéma
// "valeur -> index de texte" fonctionne identiquement ici, l'index pointant
// vers une LIGNE de PDF plutôt qu'un run Word) pour deviner où écrire, puis
// dessine par-dessus avec page.drawText() (pdf-lib). Si le PDF n'a AUCUNE
// couche de texte (scan pur sans OCR), on échoue explicitement plutôt que de
// deviner au hasard — l'OCR est hors scope de cette V1 (voir plan).
async function extraireLignesParPage(buf) {
  const pdfParse = require('pdf-parse');
  const pages = [];
  const pagerender = (pageData) => pageData.getTextContent({ normalizeWhitespace: false }).then((textContent) => {
    const lignes = [];
    let courante = null;
    for (const item of textContent.items) {
      const x = item.transform[4];
      const y = item.transform[5];
      if (courante && Math.abs(courante.y - y) < 2) {
        courante.texte += item.str;
      } else {
        courante = { texte: item.str, x, y };
        lignes.push(courante);
      }
    }
    const lignesUtiles = lignes.filter((l) => l.texte.trim());
    pages.push(lignesUtiles);
    return lignesUtiles.map((l) => l.texte).join('\n');
  });
  await pdfParse(buf, { pagerender });
  return pages;
}

const LIMITE_LIGNES_IA = 400; // meme plafond que placerChampsRestantsViaIA (docx-xml-utils.js)

async function remplirFormulairePdfPlat(buf, infosEntreprise) {
  const pagesLignes = await extraireLignesParPage(buf);
  const totalLignes = pagesLignes.reduce((s, p) => s + p.length, 0);
  if (totalLignes === 0) {
    throw new Error("Ce PDF ne contient aucun texte extractible (probablement un scan sans reconnaissance de texte) — remplissage automatique impossible, à compléter manuellement.");
  }

  const champs = aplatirInfosEntreprise(infosEntreprise);
  const entries = [];
  pagesLignes.forEach((lignes, p) => lignes.forEach((ligne, i) => entries.push({ page: p, ligne, texte: ligne.texte })));
  const entriesLimitees = entries.slice(0, LIMITE_LIGNES_IA);

  const champsPlaces = [];
  const champsNonPlaces = [];
  let mapping = null;
  if (entriesLimitees.length > 0 && Object.keys(champs).length > 0) {
    try {
      mapping = await mapperChampsBordereau(entriesLimitees.map((e) => e.texte), champs);
    } catch (e) {
      console.error('[seao-formulaire] Mapping IA (PDF plat) échoué:', e.message);
    }
  }

  const pdfDoc = await PDFDocument.load(buf);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const ROUGE = rgb(0.784, 0.063, 0.180); // texte ajoute visuellement distinct de l'original

  for (const cle of Object.keys(champs)) {
    const idx = mapping ? mapping[cle] : null;
    const entree = (idx !== null && idx !== undefined) ? entriesLimitees[idx] : null;
    if (!entree) { champsNonPlaces.push(NOMS_LISIBLES[cle] || cle); continue; }
    try {
      const page = pdfDoc.getPage(entree.page);
      const largeurLigne = font.widthOfTextAtSize(entree.ligne.texte, 9);
      page.drawText(String(champs[cle]), {
        x: entree.ligne.x + largeurLigne + 12, y: entree.ligne.y, size: 9, font, color: ROUGE,
      });
      champsPlaces.push(cle);
    } catch (e) {
      console.error('[seao-formulaire] Champ PDF plat non dessine:', cle, e.message);
      champsNonPlaces.push(NOMS_LISIBLES[cle] || cle);
    }
  }

  const buffer = Buffer.from(await pdfDoc.save());
  return { buffer, champsPlaces, champsNonPlaces };
}

module.exports = {
  remplirFormulaireDocx, remplirFormulairePdfAcroForm, remplirFormulairePdfPlat,
  aplatirInfosEntreprise, NOMS_LISIBLES,
};
