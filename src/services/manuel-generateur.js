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
const { ajouterBufferAuDocument, estamperPagesAsBuilt } = require('./pdf-manuel-assembleur');
const {
  preparerPolices, dessinerCouverture, dessinerSectionRedigee,
  dessinerPageSeparatrice, construireSommaireEtNumeroter,
} = require('./manuel-mise-en-page');

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
    // ── Assemblage « modèle Norma McAlister » (2026-07-15) : le document
    // final est reconstruit de zéro en pdf-lib (couverture avec photo,
    // sections rédigées stylées, pages séparatrices, sommaire pointillé).
    // Le .docx converti ne fournit plus QUE la section « Directives
    // d'exploitation et d'entretien » (texte long + liste de contrôle avec
    // les champs Commentaire 1-9), localisée par son titre.
    const pdfDoc = await PDFDocument.create();
    const fonts = await preparerPolices(pdfDoc);

    // Photo de couverture (catégorie photo_couverture, image jpg/png)
    let photoImage = null;
    try {
      const photoBufs = await chargerBuffersCategorie(documents.photo_couverture);
      const photoBuf = photoBufs[0];
      if (photoBuf) {
        if (photoBuf[0] === 0xFF && photoBuf[1] === 0xD8) photoImage = await pdfDoc.embedJpg(photoBuf);
        else if (photoBuf[0] === 0x89 && photoBuf[1] === 0x50) photoImage = await pdfDoc.embedPng(photoBuf);
      }
    } catch (e) {
      console.error('[manuel-generateur] Photo de couverture illisible, couverture sans photo :', e.message);
    }

    const dossier = champs.NUMERO_DOSSIER || '';
    const sousTitre = champs.NOM_DU_PROJET || '';

    // 1. Couverture + 2. placeholder du sommaire (remplacé à la fin)
    dessinerCouverture(pdfDoc, fonts, champs, photoImage);
    pdfDoc.addPage([612, 792]);

    const sections = [];
    const sectionRedigee = (label, options) => {
      sections.push({ label, pageDebut: pdfDoc.getPageCount() + 1 });
      dessinerSectionRedigee(pdfDoc, fonts, {
        numero: sections.length, titre: label, sousTitre, dossier, ...options,
      });
    };

    // Sections rédigées 1-4 (mêmes contenus que l'ancien .docx, mis en page)
    sectionRedigee('Liste des intervenants', {
      intro: { texte: "Principaux intervenants liés au projet et à l'exécution des travaux." },
      blocs: [
        { titre: 'Propriétaire', texte: champs.PROPRIETAIRE },
        { titre: 'Consultant', texte: champs.CONSULTANT },
        { titre: 'Entrepreneur général', texte: champs.ENTREPRENEUR_GENERAL },
        { titre: 'Entrepreneur couvreur', texte: champs.ENTREPRENEUR_COUVREUR },
      ].filter((b) => b.texte),
    });

    const blocsFournisseurs = [
      { titre: 'Fournisseur 1', texte: champs.FOURNISSEUR_1 },
      { titre: 'Fournisseur 2', texte: champs.FOURNISSEUR_2 },
      { titre: 'Fournisseur 3', texte: champs.FOURNISSEUR_3 },
      { titre: 'Fournisseur 4', texte: champs.FOURNISSEUR_4 },
      { titre: 'Sous-traitant 1', texte: champs.SOUS_TRAITANT_1 },
      { titre: 'Sous-traitant 2', texte: champs.SOUS_TRAITANT_2 },
    ].filter((b) => b.texte);
    if (blocsFournisseurs.length > 0) {
      sectionRedigee('Liste des fournisseurs et sous-traitants', {
        intro: { texte: 'Fournisseurs de matériaux et sous-traitants ayant participé aux travaux.' },
        blocs: blocsFournisseurs,
      });
    }

    const blocsDescription = [{ titre: 'Description', texte: champs.DESCRIPTION_TRAVAUX || '(à compléter)' }];
    if (champs.ELEMENTS_CLES) {
      const items = String(champs.ELEMENTS_CLES).split('\n').map((l) => l.trim()).filter(Boolean);
      if (items.length > 0) blocsDescription.push({ titre: 'Éléments clés', items });
    }
    sectionRedigee('Description des travaux exécutés', {
      intro: {
        titre: 'Composition complète de la toiture installée',
        texte: 'Telle que décrite au devis (coupe-vapeur, isolant et épaisseur/pente, panneaux de support, membrane(s), relevés, solins, etc.).',
      },
      blocs: blocsDescription,
    });

    sectionRedigee('Détails et imprévus', {
      blocs: [{
        titre: 'Détails et imprévus',
        texte: champs.DETAILS_IMPREVUS || 'Aucun imprévu majeur — les travaux se sont déroulés conformément aux documents contractuels.',
      }],
    });

    // 5. Directives d'exploitation et d'entretien : pages reprises du .docx
    // converti (texte long + liste de contrôle Commentaire 1-9). On coupe
    // avant l'éventuel titre « Garanties » résiduel du gabarit (section vide,
    // remplacée ici par une vraie page séparatrice).
    const pagesTexteBase = await texteParPage(manuelPdfBuf);
    let debutDirectives = pagesTexteBase.findIndex((t) => /Directives d.exploitation/i.test(t || ''));
    if (debutDirectives === -1) {
      console.error('[manuel-generateur] Titre « Directives » introuvable dans le .docx converti — reprise des pages 3+ par défaut.');
      debutDirectives = Math.min(2, pagesTexteBase.length - 1);
    }
    let finDirectives = pagesTexteBase.length;
    for (let i = debutDirectives + 1; i < pagesTexteBase.length; i++) {
      const t = (pagesTexteBase[i] || '').trim();
      if (t.length < 220 && /Garanties/i.test(t)) { finDirectives = i; break; }
    }
    sections.push({ label: "Directives d'exploitation et d'entretien", pageDebut: pdfDoc.getPageCount() + 1 });
    const docxDoc = await PDFDocument.load(manuelPdfBuf);
    const indices = [];
    for (let i = debutDirectives; i < finDirectives; i++) indices.push(i);
    const pagesDirectives = await pdfDoc.copyPages(docxDoc, indices);
    for (const p of pagesDirectives) pdfDoc.addPage(p);

    // Brochure marketing : matériel accessoire, sans titre ni entrée de
    // sommaire, toujours juste après les directives.
    for (const buf of brochureBufs) await ajouterBufferAuDocument(pdfDoc, buf);

    // Catégories de documents joints : page séparatrice stylée + contenu
    async function ajouterSection(label, buffers, { tamponner = false, note } = {}) {
      if (!buffers || buffers.length === 0) return;
      sections.push({ label, pageDebut: pdfDoc.getPageCount() + 1 });
      dessinerPageSeparatrice(pdfDoc, fonts, {
        numero: sections.length, titre: label,
        sousTitre: [sousTitre, dossier ? 'Dossier ' + dossier : ''].filter(Boolean).join('  ·  '),
        note,
      });
      for (const buf of buffers) {
        const pagesAjoutees = await ajouterBufferAuDocument(pdfDoc, buf);
        if (tamponner) estamperPagesAsBuilt(fonts, pagesAjoutees);
      }
    }

    // Garanties fusionnées en UNE section (comme le modèle) : garantie de
    // l'entrepreneur (T3E) puis garantie(s) du fabricant.
    await ajouterSection('Garanties', [...garantieT3EBufs, ...garantieBufs], {
      note: "Cette section contient les garanties émises pour ce projet : garantie de l'entrepreneur couvreur (Toitures Trois Étoiles Inc.) et garantie du fabricant.",
    });
    await ajouterSection("Manuel d'entretien préventif", manuelEntretienBuf ? [manuelEntretienBuf] : [], {
      note: "Cette section contient le manuel d'entretien préventif joint au dossier.",
    });
    await ajouterSection('Attestation de conformité CNESST', attestationCnesstBufs, {
      note: 'Cette section contient l\'attestation de conformité délivrée par la CNESST.',
    });
    await ajouterSection('Attestation de conformité CCQ', attestationCcqBufs, {
      note: 'Cette section contient l\'attestation de conformité délivrée par la Commission de la construction du Québec.',
    });
    await ajouterSection("Dessins d'atelier", dessinsAtelierBufs, {
      note: "Cette section contient les dessins d'atelier approuvés pour ce projet.",
    });
    await ajouterSection('Fiches techniques', fichesTechniquesBufs, {
      note: 'Cette section contient les fiches techniques des matériaux installés.',
    });
    await ajouterSection('Fiches de sécurité (SDS)', fichesSecuriteBufs, {
      note: 'Cette section contient les fiches de données de sécurité (SDS) des produits utilisés.',
    });
    await ajouterSection('Plans tels que construits (as-built)', plansAsBuiltBufs, {
      tamponner: true,
      note: 'Cette section contient les plans tels que construits (as-built) du projet.',
    });

    await construireSommaireEtNumeroter(pdfDoc, sections, { dossier, sousTitre });

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
