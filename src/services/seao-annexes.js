// Detection + fusion automatique des "annexes a joindre" d'un formulaire
// SEAO — un vrai formulaire de soumission demande souvent d'inserer un
// document reel (attestation CNESST, certificat ISO, autorisation AMP...)
// juste apres une page-divider du type "(le SOUMISSIONNAIRE doit joindre ce
// document a sa Soumission)". Plutot que de laisser seulement un texte de
// statut a cet endroit (ex. "Conforme au 1 juillet 2026"), on retrouve le
// VRAI document dans la base de connaissances et on l'insere directement.
const { PDFDocument } = require('pdf-lib');
const { downloadBuffer, sanitizeKey, BUCKETS } = require('./storage');

// Chaque categorie : motifs qui identifient la page-divider dans le texte du
// formulaire, puis motifs de TITRE pour retrouver le bon document dans la
// base de connaissances. `eviter` ecarte les titres qui appartiennent
// typiquement a une autre entite (ex. "Service d'entretien...") — mieux
// vaut ne rien joindre que de joindre le document de la mauvaise compagnie
// (voir le piege NEQ/RBQ/TPS decouvert manuellement sur un vrai formulaire).
const CATEGORIES_ANNEXES = [
  { cle: 'CNESST', libelle: 'Conformité CNESST', declencheurs: [/cnesst/i], titres: ['conformite cnesst', 'conformité cnesst'], eviter: ['service'] },
  { cle: 'ISO_QUALITE', libelle: 'Certificat système assurance qualité (ISO)', declencheurs: [/syst[eè]me d.assurance qualit[eé]/i, /\biso\s?9001\b/i], titres: ['iso 9001', 'iso9001'], eviter: ['service'] },
  { cle: 'FRANCISATION', libelle: 'Certificat de francisation (OQLF)', declencheurs: [/francisation/i, /\boqlf\b/i], titres: ['francisation'], eviter: ['service'] },
  { cle: 'AMP', libelle: "Autorisation de contracter de l'AMP", declencheurs: [/autorit[eé] des march[eé]s publics/i, /\bamp\b.{0,20}contracter/i, /contracter.{0,20}\bamp\b/i], titres: ['amp'], eviter: ['service'] },
  { cle: 'REVENU_QUEBEC', libelle: 'Attestation de Revenu Québec', declencheurs: [/attestation de revenu qu[eé]bec/i], titres: ['revenu québec', 'attestation de revenu'], eviter: ['service', 'entretien'] },
];

function categoriePourPage(texte) {
  if (!/doit joindre ce document|joindre.{0,15}(a|à) (la|sa) soumission/i.test(texte)) return null;
  for (const cat of CATEGORIES_ANNEXES) {
    if (cat.declencheurs.some((re) => re.test(texte))) return cat;
  }
  return null;
}

async function chargerDocumentsActifs(db) {
  const r = await db.execute(`SELECT id, titre, nom_fichier FROM documents WHERE statut = 'actif'`);
  return r.rows;
}

function trouverDocumentPourCategorie(documents, categorie) {
  const candidats = documents.filter((d) =>
    categorie.titres.some((t) => d.titre.toLowerCase().includes(t.toLowerCase()))
  );
  // Jamais un candidat de la liste "eviter" — mieux vaut ne rien joindre que
  // de joindre le document d'une entite juridique differente.
  const propres = candidats.filter((d) =>
    !categorie.eviter.some((mot) => d.titre.toLowerCase().includes(mot))
  );
  return propres[0] || null;
}

// Detecte les annexes a joindre dans le PDF DEJA REMPLI (pdfDoc, modifie sur
// place), retrouve les vrais documents correspondants dans la base de
// connaissances, et les insere directement apres leur page-divider
// respective. Retourne aussi la liste des categories detectees mais non
// trouvees (pour affichage dans la page de synthese).
async function joindreAnnexesReelles(db, pdfDoc) {
  const pdfParse = require('pdf-parse');
  const bytes = await pdfDoc.save();
  const buf = Buffer.from(bytes);

  const textesParPage = [];
  const pagerender = (pageData) => pageData.getTextContent().then((tc) => {
    const texte = tc.items.map((i) => i.str).join(' ');
    textesParPage.push(texte);
    return texte;
  });
  await pdfParse(buf, { pagerender });

  const detectees = [];
  textesParPage.forEach((texte, index) => {
    const cat = categoriePourPage(texte);
    if (cat) detectees.push({ index, categorie: cat });
  });
  if (detectees.length === 0) return { annexesJointes: [], annexesNonTrouvees: [] };

  const documents = await chargerDocumentsActifs(db);
  const trouves = [];
  const nonTrouves = [];
  for (const item of detectees) {
    const doc = trouverDocumentPourCategorie(documents, item.categorie);
    if (doc) trouves.push({ ...item, doc });
    else nonTrouves.push(item.categorie.libelle);
  }

  // Insertion en ordre decroissant d'index pour ne jamais decaler les index
  // pas encore traites.
  trouves.sort((a, b) => b.index - a.index);
  const jointsAvecSucces = [];
  for (const { index, categorie, doc } of trouves) {
    try {
      const docBuf = await downloadBuffer(BUCKETS.DOCUMENTS, sanitizeKey(doc.nom_fichier));
      if (!docBuf) { nonTrouves.push(categorie.libelle); continue; }
      const src = await PDFDocument.load(docBuf, { ignoreEncryption: true });
      const copiees = await pdfDoc.copyPages(src, src.getPageIndices());
      copiees.forEach((p, i) => pdfDoc.insertPage(index + 1 + i, p));
      jointsAvecSucces.push(categorie.libelle);
    } catch (e) {
      console.error('[seao-annexes] Fusion document échouée:', doc.titre, e.message);
      nonTrouves.push(categorie.libelle);
    }
  }

  return { annexesJointes: jointsAvecSucces, annexesNonTrouvees: nonTrouves };
}

module.exports = { joindreAnnexesReelles };
