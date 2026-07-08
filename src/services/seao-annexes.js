// Detection + fusion automatique des "annexes a joindre" d'un formulaire
// SEAO — un vrai formulaire de soumission demande souvent d'inserer un
// document reel (attestation CNESST, certificat ISO, autorisation AMP...)
// juste apres une page-divider du type "(le SOUMISSIONNAIRE doit joindre ce
// document a sa Soumission)". Plutot que de laisser seulement un texte de
// statut a cet endroit (ex. "Conforme au 1 juillet 2026"), on retrouve le
// VRAI document dans la base de connaissances et on l'insere directement.
const { PDFDocument } = require('pdf-lib');
const { downloadBuffer, sanitizeKey, BUCKETS } = require('./storage');

// L'extraction de texte (pdf-parse) de certains PDF SEAO fragmente des mots
// avec des espaces parasites dus au crenage interne du PDF (ex. "CERTIF
// ICAT", "QUÉB EC") — une regex normale sur le texte brut rate donc des
// correspondances pourtant evidentes visuellement. On compare a la place sur
// une version DEBARRASSEE de tous les espaces/ponctuation, ce qui rend la
// detection insensible a ce genre de coupure.
function normaliser(texte) {
  return texte.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}

const MOT_JOINDRE = normaliser('doit joindre ce document');

// Chaque categorie : motifs (deja normalises) qui identifient la
// page-divider dans le texte du formulaire, puis motifs de TITRE pour
// retrouver le bon document dans la base de connaissances. `eviter` ecarte
// les titres qui appartiennent typiquement a une autre entite (ex. "Service
// d'entretien...") — mieux vaut ne rien joindre que de joindre le document
// de la mauvaise compagnie (voir le piege NEQ/RBQ/TPS decouvert manuellement
// sur un vrai formulaire).
// "departement service" : dossier reseau ou vivent TOUS les documents de
// l'entite "Service d'entretien Toitures Trois Etoiles Inc." — un titre de
// fichier seul ne mentionne pas toujours "service" (ex. un fichier nomme
// juste "Attestation de Revenu Quebe.pdf" qui, une fois ouvert, s'avere
// pourtant etabli au nom de l'entite Service) alors que son CHEMIN complet
// le trahit systematiquement. Verifier le chemin en plus du titre est donc
// la seule protection fiable contre ce piege deja rencontre deux fois.
const DOSSIER_AUTRE_ENTITE = 'departement service';

const CATEGORIES_ANNEXES = [
  { cle: 'CNESST', libelle: 'Conformité CNESST', motifs: ['cnesst'], titres: ['conformite cnesst', 'conformité cnesst'], eviter: ['service', DOSSIER_AUTRE_ENTITE] },
  { cle: 'ISO_QUALITE', libelle: 'Certificat système assurance qualité (ISO)', motifs: ['assurancequalite', 'iso9001'], titres: ['iso 9001', 'iso9001'], eviter: ['service', DOSSIER_AUTRE_ENTITE] },
  { cle: 'AMP', libelle: "Autorisation de contracter de l'AMP", motifs: ['marchespublics', 'contracterdelamp'], titres: ['amp'], eviter: ['service', DOSSIER_AUTRE_ENTITE] },
  { cle: 'REVENU_QUEBEC', libelle: 'Attestation de Revenu Québec', motifs: ['revenuquebec'], titres: ['revenu québec', 'attestation de revenu'], eviter: ['service', 'entretien', DOSSIER_AUTRE_ENTITE] },
];

// Cas particulier : la page "Charte de la langue française" ne contient
// jamais la phrase-gabarit "doit joindre ce document" (c'est une declaration
// a cocher, pas un simple renvoi vers une piece jointe) — elle utilise "je
// le joins" a l'interieur des cases a cocher. Detection dediee.
const CATEGORIE_FRANCISATION = { cle: 'FRANCISATION', libelle: 'Certificat de francisation (OQLF)', titres: ['francisation'], eviter: ['service', DOSSIER_AUTRE_ENTITE] };

function categoriePourPage(texte) {
  const n = normaliser(texte);
  if (n.includes(MOT_JOINDRE)) {
    for (const cat of CATEGORIES_ANNEXES) {
      if (cat.motifs.some((m) => n.includes(m))) return cat;
    }
  }
  if (n.includes(normaliser('charte de la langue française')) && n.includes(normaliser('cocher une des'))) {
    return CATEGORIE_FRANCISATION;
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
  // de joindre le document d'une entite juridique differente. On verifie le
  // TITRE et le CHEMIN complet (nom_fichier), car le titre seul ne revele pas
  // toujours de quelle entite provient reellement le document.
  const propres = candidats.filter((d) => {
    const cible = `${d.titre} ${d.nom_fichier || ''}`.toLowerCase();
    return !categorie.eviter.some((mot) => cible.includes(mot));
  });
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
