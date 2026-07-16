// Extraction structurée des exigences d'un appel d'offres SEAO (dates de
// travaux, méthode de dépôt, cautionnements, lettre d'engagement, lettre
// d'assureur, autres documents requis) — chaque valeur retournée par l'IA est
// accompagnée de sa source exacte (document + page + extrait) et d'un niveau
// de confiance, jamais affichée comme un fait certain sans preuve.
const path = require('path');
const { downloadBuffer, BUCKETS } = require('./storage');
const { texteParPage } = require('./document-parser');
const { analyserExigencesAppelOffre } = require('./claude-client');

// Ordre de priorité en cas de contradiction entre documents (section 10 de la
// demande) — le plus prioritaire en premier. Les addendas passent toujours
// avant les documents qu'ils modifient, quelle que soit leur catégorie.
const PRIORITE_CATEGORIE = [
  'addenda',
  'documents_administratifs',
  'formulaire_soumission',
  'devis',
  'plans',
];

function rangPriorite(categorie) {
  const i = PRIORITE_CATEGORIE.indexOf(categorie);
  return i === -1 ? PRIORITE_CATEGORIE.length : i;
}

// Budget de caractères envoyés à l'IA — même logique que construireContexteTexte
// (seao-autofill.js) : un appel d'offres peut avoir des dizaines de documents,
// il faut couper explicitement plutôt que de dépasser les limites de contexte.
const BUDGET_CARACTERES = 180000;
const EXTRAIT_MAX_PAR_PAGE = 2500;

async function extraireTexteDocument(doc) {
  const buf = await downloadBuffer(BUCKETS.SEAO, doc.cle_storage);
  if (!buf) return null;
  const ext = path.extname(doc.nom_fichier || '').toLowerCase();

  try {
    if (ext === '.pdf') {
      const pages = await texteParPage(buf);
      return pages.map((texte, i) => ({ page: i + 1, texte }));
    }
    if (ext === '.docx') {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer: buf });
      return [{ page: null, texte: result.value || '' }];
    }
    if (ext === '.doc') {
      // word-extractor n'accepte qu'un chemin de fichier — hors scope ici
      // (rare pour des documents SEAO récents, presque toujours PDF/docx).
      return null;
    }
    // .xlsx/.xls : pas de support tableur pour l'extraction d'exigences pour
    // l'instant (rare pour un formulaire/devis/addenda SEAO) — voir limitations.
  } catch (e) {
    console.error('[seao-exigences] Lecture échouée:', doc.nom_fichier, e.message);
    return null;
  }
  return null;
}

// Construit le contexte texte envoyé à l'IA, document par document, avec des
// marqueurs de page explicites — indispensables pour que l'IA puisse citer une
// source exacte (document + page) plutôt qu'inventer un numéro de page.
async function construireContexte(documents) {
  const tries = [...documents].sort((a, b) => rangPriorite(a.categorie) - rangPriorite(b.categorie));

  const resultats = await Promise.all(tries.map(async (doc) => {
    const pages = await extraireTexteDocument(doc);
    if (!pages) return null;
    return { doc, pages };
  }));

  const morceaux = [];
  const ignores = [];
  let budget = BUDGET_CARACTERES;
  for (const r of resultats) {
    if (!r) continue;
    if (budget <= 0) { ignores.push(r.doc.nom_fichier); continue; }
    const entete = `\n\n===== DOCUMENT: "${r.doc.nom_fichier}" (catégorie: ${r.doc.categorie}) =====`;
    let bloc = entete;
    for (const p of r.pages) {
      if (budget <= 0) break;
      const texte = (p.texte || '').trim();
      if (!texte) continue;
      const extrait = texte.substring(0, Math.min(EXTRAIT_MAX_PAR_PAGE, budget));
      const marqueur = p.page ? `\n--- page ${p.page} ---\n` : '\n--- (page non déterminée) ---\n';
      bloc += marqueur + extrait;
      budget -= extrait.length;
    }
    morceaux.push(bloc);
  }
  if (ignores.length) {
    console.warn('[seao-exigences] Document(s) exclus par le budget de caractères :', ignores);
  }
  return { contexte: morceaux.join('\n'), documentsIgnores: ignores, documentsLus: resultats.filter(Boolean).map((r) => r.doc.nom_fichier) };
}

// Aplati le résultat structuré de l'IA en lignes prêtes à insérer dans la
// table `exigences`. Chaque catégorie fixe correspond à une ligne unique ;
// `autres_documents` peut produire plusieurs lignes.
function aplatirExtraction(extraction) {
  const lignes = [];
  const CHAMPS_UNIQUES = {
    date_debut_travaux: 'Date de début des travaux',
    date_fin_travaux: 'Date de fin des travaux',
    methode_depot: 'Méthode de remise de la soumission',
    cautionnement_soumission: 'Cautionnement de soumission',
    cautionnement_execution: "Cautionnement d'exécution",
    lettre_engagement: "Lettre d'engagement",
    lettre_assureur: "Lettre ou preuve d'assureur",
  };

  for (const [categorie, titre] of Object.entries(CHAMPS_UNIQUES)) {
    const c = extraction[categorie];
    if (!c) continue;
    lignes.push({
      categorie,
      titre,
      valeur: c.valeur || '',
      statut: c.statut || 'a_verifier',
      obligatoire: 1,
      moment_remise: c.moment_remise || null,
      document_source: c.document_source || null,
      numero_page: c.page_source || null,
      extrait_source: c.extrait_source || null,
      niveau_confiance: c.niveau_confiance || 'faible',
    });
  }

  for (const doc of extraction.autres_documents || []) {
    lignes.push({
      categorie: 'autre_document',
      titre: doc.nom || 'Document non identifié',
      valeur: doc.statut === 'confirme' ? 'Requis' : (doc.statut || ''),
      statut: doc.statut || 'a_verifier',
      obligatoire: doc.obligatoire ? 1 : 0,
      moment_remise: doc.moment_remise || null,
      document_source: doc.document_source || null,
      numero_page: doc.page_source || null,
      extrait_source: doc.extrait_source || null,
      niveau_confiance: doc.niveau_confiance || 'faible',
    });
  }

  return lignes;
}

// Analyse un appel d'offres : télécharge tous ses documents, construit le
// contexte, appelle l'IA, et REMPLACE les lignes auto-extraites existantes
// (jamais celles validées manuellement — voir section 16 de la demande).
async function analyserExigences(db, appelOffreId) {
  const docsRes = await db.execute({ sql: 'SELECT * FROM appels_offres_documents WHERE appel_offre_id = ?', args: [appelOffreId] });
  if (docsRes.rows.length === 0) {
    return { error: 'Aucun document importé pour cet appel d\'offres — importez au moins le devis ou le formulaire de soumission avant d\'analyser.' };
  }

  const { contexte, documentsIgnores, documentsLus } = await construireContexte(docsRes.rows);
  if (!contexte.trim()) {
    return { error: 'Aucun des documents importés n\'a pu être lu (PDF scanné sans texte, fichier corrompu, ou format non supporté).' };
  }

  const extraction = await analyserExigencesAppelOffre(contexte);
  if (extraction.error) return extraction;

  const lignes = aplatirExtraction(extraction);

  // Ne jamais écraser une ligne validée manuellement (valide_manuellement = 1) :
  // on la conserve telle quelle, on ne supprime/réinsère que les lignes non
  // validées de la même catégorie.
  await db.execute({
    sql: `DELETE FROM exigences WHERE appel_offre_id = ? AND valide_manuellement = 0`,
    args: [appelOffreId],
  });

  const validees = await db.execute({ sql: 'SELECT categorie, titre FROM exigences WHERE appel_offre_id = ? AND valide_manuellement = 1', args: [appelOffreId] });
  const dejaValidees = new Set(validees.rows.map((r) => r.categorie + '|' + r.titre));

  let inserees = 0;
  for (const l of lignes) {
    if (dejaValidees.has(l.categorie + '|' + l.titre)) continue; // une correction manuelle prime
    await db.execute({
      sql: `INSERT INTO exigences
        (appel_offre_id, categorie, titre, valeur, statut, obligatoire, moment_remise,
         document_source, numero_page, extrait_source, niveau_confiance, valide_manuellement)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      args: [appelOffreId, l.categorie, l.titre, l.valeur, l.statut, l.obligatoire, l.moment_remise,
        l.document_source, l.numero_page, l.extrait_source, l.niveau_confiance],
    });
    inserees++;
  }

  return { ok: true, inserees, documentsLus, documentsIgnores };
}

module.exports = { analyserExigences, construireContexte };
