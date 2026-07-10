// Generation complete d'un manuel de fin de chantier : remplissage du .docx,
// conversion PDF, telechargement de toutes les categories de documents et
// fusion finale. Extrait de src/routes/manuels.js pour pouvoir etre appele
// SOIT en synchrone (Render/local, aucun plafond de duree problematique) SOIT
// depuis la route interne /internal/generer-manuel (declenchee en
// arriere-plan par Vercel — voir commentaire dans manuels.js sur le plafond
// de 60s du plan Hobby).
const { PDFDocument } = require('pdf-lib');
const { downloadBuffer, uploadBuffer, BUCKETS } = require('./storage');
const { parsePdfBuffer, texteParPage } = require('./document-parser');
const { remplirManuel } = require('./manuel-filler');
const { convertirDocxEnPdf } = require('./docx-to-pdf');
const {
  preparerPolices, ajouterBufferAuDocument, creerPageTitre,
  estamperPagesAsBuilt, construireSommaireEtNumeroter,
} = require('./pdf-manuel-assembleur');

// Documents par defaut (reutilises sur tous les manuels, sauf remplacement
// projet par projet) — a uploader une fois dans le bucket "documents" via la
// page Connaissances.
// NOTE (2026-07-09) : attestation_ccq n'a PAS de defaut — contrairement a la
// conformite CNESST (une lettre generale reutilisable pour toute l'entreprise),
// les documents CCQ reels ("etat de situation") sont specifiques a CHAQUE
// chantier (numero de projet, donneur d'ouvrage, dates du contrat...) — les
// reutiliser d'un projet a l'autre serait FAUX, pas juste incomplet.
const DEFAUTS = {
  manuel_entretien: 'manuels-defauts/manuel-entretien-preventif.pdf',
  attestation_cnesst: 'manuels-defauts/attestation-cnesst.pdf',
  garantie_t3e: 'manuels-defauts/garantie-t3e.pdf',
  brochure_marketing: 'manuels-defauts/guide-toitures-bp.pdf',
};

// Les 4 champs de garantie restent en base pour reference interne mais ne
// doivent jamais etre imprimes (la section Garanties du .docx ne contient
// plus que le titre).
const CHAMPS_GARANTIE_NON_IMPRIMES = ['NUMERO_GARANTIE', 'SURFACE_GARANTIE', 'DUREE_GARANTIE', 'DATE_FIN_GARANTIE'];

async function chargerBuffersCategorie(documents) {
  const buffers = await Promise.all((documents || []).map((doc) => downloadBuffer(BUCKETS.MANUELS, doc.key)));
  return buffers.filter(Boolean);
}

// Charge le PDF par defaut d'une categorie, sauf si l'utilisateur en a
// uploade un pour CE manuel (override projet par projet).
async function chargerAvecDefaut(documents, cleDefaut) {
  const overrides = await chargerBuffersCategorie(documents);
  if (overrides.length > 0) return overrides;
  if (!cleDefaut) return [];
  const buf = await downloadBuffer(BUCKETS.DOCUMENTS, cleDefaut);
  return buf ? [buf] : [];
}

// Relit tout depuis la DB par id plutot que de recevoir les donnees en
// parametre : au moment ou cette fonction s'execute (potentiellement apres un
// aller-retour HTTP vers Render), la requete HTTP initiale de l'utilisateur
// est deja terminee — champs/documents/non_applicable ont ete sauvegardes
// juste avant par l'appelant (voir POST /manuels/generer/:id).
// Ne leve jamais d'exception : retourne toujours { ok, erreur? } et enregistre
// l'echec dans data.generation pour que la page de revision puisse l'afficher,
// meme quand personne n'attend la reponse HTTP (cas du declenchement Render).
async function genererEtSauvegarderManuel(db, id) {
  const r = await db.execute({ sql: 'SELECT * FROM manuels WHERE id = ?', args: [id] });
  if (r.rows.length === 0) return { ok: false, erreur: 'Manuel introuvable' };

  const row = r.rows[0];
  let data;
  try { data = JSON.parse(row.contenu); } catch (_) { data = {}; }
  const champs = data.champs || {};
  const documents = data.documents || {};
  const nonApplicables = data.non_applicable || {};
  const inclureBrochure = !!data.inclure_brochure;

  async function marquerErreur(message) {
    console.error('[manuel-generateur] Echec generation manuel', id, ':', message);
    await db.execute({
      sql: `UPDATE manuels SET contenu = ? WHERE id = ?`,
      args: [JSON.stringify({ ...data, generation: { statut: 'erreur', erreur: message, quand: new Date().toISOString() } }), id],
    });
    return { ok: false, erreur: message };
  }

  const champsPourDocx = { ...champs };
  for (const k of CHAMPS_GARANTIE_NON_IMPRIMES) delete champsPourDocx[k];

  let docxBuf;
  try {
    docxBuf = await remplirManuel(champsPourDocx);
  } catch (e) {
    return marquerErreur('Erreur lors du remplissage du manuel : ' + e.message);
  }

  let manuelPdfBuf;
  try {
    manuelPdfBuf = await convertirDocxEnPdf(docxBuf);
  } catch (e) {
    return marquerErreur('Erreur lors de la conversion PDF du manuel (le .docx genere est disponible mais pas la fusion complete) : ' + e.message);
  }

  // Plans tels que construits : dedoublonnage — si des plans as-built ont ete
  // uploades, ils font foi ; sinon on retombe sur les plans du projet (meme
  // dessins, aucun changement structurel constate) plutot que d'afficher les
  // deux sections avec les memes images.
  const plansSourceDocs = (documents.plans_as_built && documents.plans_as_built.length > 0)
    ? documents.plans_as_built
    : (documents.plan || []);

  let manuelEntretienBuf, attestationCnesstBufs, attestationCcqBufs, garantieT3EBufs, garantieBufs,
    dessinsAtelierBufs, fichesTechniquesBufs, fichesSecuriteBufs, plansAsBuiltBufs, brochureBufs;
  try {
    [
      manuelEntretienBuf, attestationCnesstBufs, attestationCcqBufs, garantieT3EBufs, garantieBufs,
      dessinsAtelierBufs, fichesTechniquesBufs, fichesSecuriteBufs, plansAsBuiltBufs, brochureBufs,
    ] = await Promise.all([
      downloadBuffer(BUCKETS.DOCUMENTS, DEFAUTS.manuel_entretien),
      chargerAvecDefaut(documents.attestation_cnesst, DEFAUTS.attestation_cnesst),
      chargerBuffersCategorie(documents.attestation_ccq),
      chargerAvecDefaut(documents.garantie_t3e, DEFAUTS.garantie_t3e),
      chargerBuffersCategorie(documents.garantie_fabricant),
      chargerBuffersCategorie(documents.dessins_atelier),
      chargerBuffersCategorie(documents.fiches_techniques),
      chargerBuffersCategorie(documents.fiches_securite),
      chargerBuffersCategorie(plansSourceDocs),
      // Brochure marketing desormais optionnelle (case a cocher) : ni override
      // projet ni defaut BP ne sont charges si l'utilisateur ne l'a pas cochee.
      inclureBrochure ? chargerAvecDefaut(documents.brochure_marketing, DEFAUTS.brochure_marketing) : Promise.resolve([]),
    ]);
  } catch (e) {
    return marquerErreur('Erreur lors du telechargement des documents : ' + e.message);
  }

  let pdfFinal;
  try {
    const pdfDoc = await PDFDocument.load(manuelPdfBuf);
    const fonts = await preparerPolices(pdfDoc);
    const tailleStandard = pdfDoc.getPage(0).getSize();

    // Sections 1 a 5 deja dans le .docx : leur page de depart reelle est
    // localisee par titre exact (pdf-parse) plutot que supposee fixe, car
    // Description/Details/Directives ont une longueur variable.
    const pagesTexteBase = await texteParPage(manuelPdfBuf);
    const HEADINGS_BASE = [
      'Liste des intervenants',
      'Liste des fournisseurs et sous-traitants',
      'Description des travaux exécutés',
      'Détails et imprévus',
      "Directives d'exploitation et d'entretien",
    ];
    const sections = HEADINGS_BASE.map((label, i) => {
      const idx = pagesTexteBase.findIndex((t, pageIdx) => pageIdx >= 2 && t.includes(label));
      return { label, pageDebut: idx === -1 ? (3 + i) : idx + 1 };
    });

    const sectionsCroissantes = sections.every((s, i) => i === 0 || s.pageDebut > sections[i - 1].pageDebut);
    if (!sectionsCroissantes) {
      console.error('[manuel-generateur] ANOMALIE sommaire : pages des sections 1-5 non croissantes (%s) - repli sur la numerotation sequentielle par defaut.',
        JSON.stringify(sections));
      sections.forEach((s, i) => { s.pageDebut = 3 + i; });
    }

    async function ajouterSection(label, buffers, { tamponner = false } = {}) {
      if (!buffers || buffers.length === 0) return;
      sections.push({ label, pageDebut: pdfDoc.getPageCount() + 1 });
      creerPageTitre(pdfDoc, fonts, label, tailleStandard);
      for (const buf of buffers) {
        const pagesAjoutees = await ajouterBufferAuDocument(pdfDoc, buf);
        if (tamponner) estamperPagesAsBuilt(fonts, pagesAjoutees);
      }
    }

    // Brochure marketing : materiel accessoire, sans titre ni entree de
    // sommaire, toujours juste apres Directives d'exploitation et d'entretien.
    for (const buf of brochureBufs) await ajouterBufferAuDocument(pdfDoc, buf);

    await ajouterSection('Garantie T3E', garantieT3EBufs);
    await ajouterSection('Garantie du fabricant', garantieBufs);
    await ajouterSection("Manuel d'entretien préventif", manuelEntretienBuf ? [manuelEntretienBuf] : []);
    await ajouterSection('Attestation de conformité CNESST', attestationCnesstBufs);
    await ajouterSection('Attestation de conformité CCQ', attestationCcqBufs);
    await ajouterSection("Dessins d'atelier", dessinsAtelierBufs);
    await ajouterSection('Fiches techniques', fichesTechniquesBufs);
    await ajouterSection('Fiches de sécurité (SDS)', fichesSecuriteBufs);
    await ajouterSection('Plans tels que construits (as-built)', plansAsBuiltBufs, { tamponner: true });

    await construireSommaireEtNumeroter(pdfDoc, sections);

    pdfFinal = Buffer.from(await pdfDoc.save());
  } catch (e) {
    return marquerErreur("Erreur lors de l'assemblage final du manuel : " + e.message);
  }

  try {
    await uploadBuffer(BUCKETS.MANUELS, `${id}/manuel-final.pdf`, pdfFinal, 'application/pdf');
  } catch (e) {
    return marquerErreur('Le manuel a ete genere et fusionne (' + pdfFinal.length + ' octets) mais son enregistrement dans le stockage a echoue : ' + e.message);
  }

  await db.execute({
    sql: `UPDATE manuels SET statut = 'approuve', contenu = ?, titre = ?, numero_dossier = ? WHERE id = ?`,
    args: [
      JSON.stringify({
        champs, documents, non_applicable: nonApplicables, inclure_brochure: inclureBrochure,
        ia_erreur: data.ia_erreur || '',
        generation: { statut: 'termine', quand: new Date().toISOString() },
      }),
      champs.NOM_DU_PROJET || row.titre, champs.NUMERO_DOSSIER || row.numero_dossier, id,
    ],
  });

  return { ok: true };
}

module.exports = {
  DEFAUTS,
  CHAMPS_GARANTIE_NON_IMPRIMES,
  chargerBuffersCategorie,
  chargerAvecDefaut,
  genererEtSauvegarderManuel,
};
