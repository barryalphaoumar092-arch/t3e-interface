const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { parseDevis, parsePdfBuffer } = require('../services/document-parser');
const { analyserDevisManuel, extraireFournisseursDesFT } = require('../services/claude-client');
const { downloadBuffer, uploadBuffer, createSignedUrl, removeFile, listFiles, sanitizeKey, BUCKETS } = require('../services/storage');
const { chargerBuffersCategorie, genererEtSauvegarderManuel } = require('../services/manuel-generateur');

// Categories de documents uploades par l'utilisateur. "multiple: true" =
// plusieurs fichiers possibles. L'ORDRE de fusion réel n'est plus dérivé de
// ce tableau (voir assemblage dynamique dans POST /generer/:id) — il ne sert
// plus qu'à générer les champs d'upload et la persistance générique.
const CATEGORIES_DOCUMENTS = [
  { cle: 'dessins_atelier', multiple: true },
  { cle: 'fiches_techniques', multiple: true },
  { cle: 'fiches_securite', multiple: true },
  { cle: 'plans_as_built', multiple: true },
  { cle: 'garantie_t3e', multiple: true },
  { cle: 'garantie_fabricant', multiple: true },
  { cle: 'attestation_cnesst', multiple: false },
  { cle: 'attestation_ccq', multiple: false },
  { cle: 'plan', multiple: true },
  { cle: 'brochure_marketing', multiple: false },
  // Image (jpg/png) affichée encadrée sur la page couverture du manuel —
  // voir dessinerCouverture (manuel-mise-en-page.js).
  { cle: 'photo_couverture', multiple: false },
];

// ══════════════════════════════════════════════════════════════
//  VÉRIFICATION AVANT GÉNÉRATION (priorité utilisateur #1) — évite qu'une
//  section obligatoire (garantie, attestation, FT, SDS, plans...) se
//  retrouve vide dans le PDF final SANS QUE PERSONNE NE S'EN APERÇOIVE.
//  Chaque section a un statut ('presente'/'manquante'/'non_applicable') et
//  une regle : les sections "systeme" (defaut T3E) ne peuvent JAMAIS etre
//  marquees non applicables — si elles manquent, c'est le defaut lui-meme
//  qu'il faut fournir (voir DEFAUTS), pas une decision projet par projet.
// ══════════════════════════════════════════════════════════════
const CHECKLIST_ITEMS = [
  'Inspection de tous les éléments émergeant de la membrane de toiture (évents, ventilateurs, cheminées, etc.).',
  'Vérification de tous les drains.',
  'Vérification de la condition générale de la couverture (débris, clous, feuilles, saletés, sédiments et autres matériaux).',
  'Inspection de la membrane et de tous ses joints (éviter entreposage, tables, chaises, décorations).',
  'Vérification de l’étanchéité de tous les solins métalliques, si applicable.',
  'Vérification de la présence de granules en quantité suffisante sur toute la surface de la membrane.',
  'Communication aux personnes concernées de toute anomalie des éléments environnants et reliés à la couverture.',
  'Vérification des équipements mécaniques installés sur la toiture (supports, fixations, étanchéité des pénétrations).',
  'Anomalie(s) ou autre(s) problème(s) observé(s).',
];

const SECTIONS_VERIFICATION = [
  { cle: 'garantie_t3e', label: 'Garantie T3E', defautCle: 'garantie-t3e.pdf', peutEtreNonApplicable: false },
  { cle: 'garantie_fabricant', label: 'Garantie fabricant', peutEtreNonApplicable: true },
  { cle: 'manuel_entretien', label: "Manuel d'entretien préventif", documentsCle: null, defautCle: 'manuel-entretien-preventif.pdf', peutEtreNonApplicable: false },
  { cle: 'fiches_techniques', label: 'Fiches techniques', peutEtreNonApplicable: false },
  { cle: 'fiches_securite', label: 'Fiches de sécurité (SDS)', peutEtreNonApplicable: true },
  { cle: 'attestation_cnesst', label: 'Attestation CNESST', defautCle: 'attestation-cnesst.pdf', peutEtreNonApplicable: false, verifierExpiration: true },
  { cle: 'attestation_ccq', label: 'Attestation CCQ', peutEtreNonApplicable: false },
  { cle: 'plans_as_built', label: 'Plans tels que construits (as-built)', repliCle: 'plan', peutEtreNonApplicable: true },
];

// Best-effort, UNIQUEMENT pour un format de date connu et sans ambiguite
// (lettre CNESST officielle : "Date de fin de la période de validité de
// l'attestation : 30 septembre 2026") — jamais de detection approximative
// sur un document dont le format n'est pas garanti, mieux vaut ne rien
// affirmer que d'affirmer une date fausse.
const MOIS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
function extraireDateExpirationCnesst(texte) {
  const m = texte.match(/p[ée]riode de validit[ée] de l['’]attestation\s*:\s*(\d{1,2})\s+([a-zéû]+)\s+(\d{4})/i);
  if (!m) return null;
  const mois = MOIS_FR.indexOf(m[2].toLowerCase());
  if (mois === -1) return null;
  return new Date(parseInt(m[3]), mois, parseInt(m[1]));
}

async function calculerStatutSections(documents, nonApplicables) {
  let defautsExistants = [];
  try {
    const entries = await listFiles(BUCKETS.DOCUMENTS, 'manuels-defauts');
    defautsExistants = entries.map((e) => e.name);
  } catch (e) {
    console.error('[manuels] Impossible de lister manuels-defauts:', e.message);
  }

  const resultats = [];
  for (const section of SECTIONS_VERIFICATION) {
    const na = (nonApplicables || {})[section.cle];
    if (na && na.note) {
      resultats.push({ ...section, statut: 'non_applicable', note: na.note });
      continue;
    }

    const docsProjet = (documents[section.cle] || []).concat(
      section.repliCle ? (documents[section.repliCle] || []) : []
    );
    const aUnDefaut = section.defautCle ? defautsExistants.includes(section.defautCle) : false;

    let statut;
    if (docsProjet.length > 0) statut = 'presente';
    else if (aUnDefaut) statut = 'presente';
    else if (section.defautCle) statut = 'defaut_manquant'; // fichier systeme jamais uploade — pas une decision "projet"
    else statut = 'manquante';

    let expirationInfo = null;
    if (statut === 'presente' && section.verifierExpiration) {
      try {
        const bufs = docsProjet.length > 0
          ? await chargerBuffersCategorie(documents[section.cle])
          : [await downloadBuffer(BUCKETS.DOCUMENTS, `manuels-defauts/${section.defautCle}`)];
        for (const buf of bufs) {
          if (!buf) continue;
          const { text } = await parsePdfBuffer(buf);
          const dateExp = extraireDateExpirationCnesst(text || '');
          if (dateExp) { expirationInfo = dateExp; break; }
        }
      } catch (e) {
        console.error('[manuels] Vérification expiration échouée pour', section.cle, ':', e.message);
      }
      if (expirationInfo && expirationInfo.getTime() < Date.now()) statut = 'expiree';
    }

    resultats.push({ ...section, statut, dateExpiration: expirationInfo });
  }
  return resultats;
}

// Les fiches techniques réellement approuvées sont la source fiable de "qu'est
// ce qui a vraiment été installé" — contrairement au devis, qui liste parfois
// des matériaux finalement remplacés/non utilisés en chantier. Quand des FT
// sont disponibles, leurs fabricants remplacent FOURNISSEUR_1..4 issus du devis.
async function extraireFournisseursDepuisFT(fichesTechniquesDocs) {
  if (!fichesTechniquesDocs || fichesTechniquesDocs.length === 0) return null;
  // Telechargement + parsing EN PARALLELE (Promise.all) plutot qu'un par un :
  // meme piege que persisterCategorie (voir plus haut) — avec beaucoup de
  // fiches techniques reelles (27 signalees par l'utilisateur), la version
  // sequentielle depassait le plafond de 60s de la fonction Vercel des
  // l'etape /analyser, AVANT meme d'atteindre /generer/:id (dont le timeout a
  // ete corrige separement, voir declencherGenerationDistante plus bas — ceci
  // est un point d'entree DIFFERENT, jamais couvert par ce fix-la).
  const fiches = (await Promise.all(fichesTechniquesDocs.map(async (doc) => {
    const buf = await downloadBuffer(BUCKETS.MANUELS, doc.key);
    if (!buf) return null;
    try {
      const { text } = await parsePdfBuffer(buf);
      return (text && text.trim()) ? { nom: doc.nom, texte: text } : null;
    } catch (e) {
      console.error('[manuels] Lecture FT échouée pour extraction fournisseurs:', doc.nom, e.message);
      return null;
    }
  }))).filter(Boolean);
  if (fiches.length === 0) return null;

  try {
    const result = await extraireFournisseursDesFT(fiches);
    const nonVide = ['FOURNISSEUR_1', 'FOURNISSEUR_2', 'FOURNISSEUR_3', 'FOURNISSEUR_4']
      .some((k) => (result[k] || '').trim());
    return nonVide ? result : null;
  } catch (e) {
    console.error('[manuels] Extraction fournisseurs FT échouée:', e.message);
    return null;
  }
}

async function telechargerVersFichierTemp(bucket, key, nomOriginal) {
  const buf = await downloadBuffer(bucket, key);
  if (!buf) return null;
  const tmpPath = path.join(os.tmpdir(), `t3e_manuel_${crypto.randomBytes(6).toString('hex')}_${path.basename(nomOriginal || key)}`);
  fs.writeFileSync(tmpPath, buf);
  return tmpPath;
}

// Cles generees exclusivement par /api/upload-url (voir bordereaux.js) : jamais
// de separateur de chemin.
function cleTempValide(key) {
  return typeof key === 'string' && key.length > 0 && !key.includes('/') && !key.includes('..');
}

// Deplace un fichier uploade temporairement (bucket "uploads-temp") vers le
// stockage permanent du manuel (bucket "manuels-fin-chantier"), sous
// {manuelId}/{categorie}/{fichier}.
async function persisterFichier(manuelId, categorie, tempKey, nomOriginal) {
  const buf = await downloadBuffer(BUCKETS.UPLOADS_TEMP, tempKey);
  if (!buf) return null;
  const key = sanitizeKey(`${manuelId}/${categorie}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${path.basename(nomOriginal || tempKey)}`);
  await uploadBuffer(BUCKETS.MANUELS, key, buf);
  await removeFile(BUCKETS.UPLOADS_TEMP, tempKey).catch(() => {});
  return { key, nom: nomOriginal || path.basename(tempKey) };
}

// Persiste tous les fichiers d'une categorie EN PARALLELE (Promise.all) plutot
// qu'un par un : chaque fichier fait 3 aller-retours Supabase sequentiels
// (download/upload/delete) dans persisterFichier(), et cette fonction tourne
// dans la meme requete que le parsing du devis + l'appel OpenAI. Au-dela
// d'une quinzaine de fichiers, la version sequentielle depassait le delai
// maximal de la fonction (timeout Vercel/proxy Render) avant d'avoir fini de
// tout persister. Le parallelisme ramene le temps total a celui du fichier le
// plus lent plutot qu'a la somme de tous les fichiers.
async function persisterCategorie(manuelId, categorie, cles, noms) {
  const taches = cles.map((cle, i) => {
    if (!cleTempValide(cle)) return null;
    return persisterFichier(manuelId, categorie, cle, noms[i]);
  });
  const resultats = await Promise.all(taches);
  return resultats.filter(Boolean);
}

// Supprime tous les fichiers Supabase Storage stockes sous {manuelId}/ (toutes
// categories confondues) — utilise a la suppression d'un manuel.
async function supprimerDossierManuel(manuelId) {
  for (const { cle } of CATEGORIES_DOCUMENTS) {
    try {
      const entries = await listFiles(BUCKETS.MANUELS, `${manuelId}/${cle}`);
      for (const e of entries) {
        if (e.id !== null) await removeFile(BUCKETS.MANUELS, `${manuelId}/${cle}/${e.name}`).catch(() => {});
      }
    } catch (_) {}
  }
  await removeFile(BUCKETS.MANUELS, `${manuelId}/manuel-final.pdf`).catch(() => {});
}

// ══════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════

router.get('/', async (req, res) => {
  const r = await req.db.execute(
    "SELECT id, titre, numero_dossier, statut, cree_par, created_at FROM manuels ORDER BY created_at DESC"
  );
  res.render('manuels', { manuels: r.rows });
});

router.get('/nouveau', (req, res) => {
  res.render('manuel-nouveau');
});

// ── ANALYSER : upload devis + documents du projet → extraction IA → révision ──
router.post('/analyser', async (req, res) => {
  const db = req.db;
  const { numero_dossier } = req.body;

  const devisKey = req.body.devis_key, devisName = req.body.devis_name;
  if (!cleTempValide(devisKey)) return res.status(400).send('Veuillez importer le devis du projet.');

  let devisTempPath = null;
  let texteDevis = '';
  try {
    devisTempPath = await telechargerVersFichierTemp(BUCKETS.UPLOADS_TEMP, devisKey, devisName);
    if (!devisTempPath) throw new Error('fichier introuvable dans le stockage');
    const parsed = await parseDevis(devisTempPath, devisName);
    texteDevis = parsed.text || '';
  } catch (e) {
    return res.status(400).send('Impossible de lire le devis : ' + e.message);
  } finally {
    if (devisTempPath) { try { fs.unlinkSync(devisTempPath); } catch (_) {} }
    await removeFile(BUCKETS.UPLOADS_TEMP, devisKey).catch(() => {});
  }

  if (!texteDevis.trim()) return res.status(400).send('Le devis semble vide ou illisible.');

  let ia = {};
  let iaErreur = '';
  try {
    ia = await analyserDevisManuel(texteDevis);
    if (ia.error) { iaErreur = ia.error; ia = {}; }
  } catch (e) {
    iaErreur = e.message;
  }

  const champs = {
    NOM_DU_PROJET: ia.NOM_DU_PROJET || '',
    CLIENT: ia.CLIENT || '',
    ADRESSE_PROJET: ia.ADRESSE_PROJET || '',
    NUMERO_DOSSIER: numero_dossier?.trim() || '',
    DATE: new Date().toLocaleDateString('fr-CA', { year: 'numeric', month: 'long', day: 'numeric' }),
    PROPRIETAIRE: ia.PROPRIETAIRE || '',
    CONSULTANT: ia.CONSULTANT || '',
    ENTREPRENEUR_GENERAL: ia.ENTREPRENEUR_GENERAL || '',
    ENTREPRENEUR_COUVREUR: 'Toitures Trois Étoiles — 7550 Rue Saint-Patrick, Montréal, QC H8N 1V1 — 514-365-6600',
    FOURNISSEUR_1: ia.FOURNISSEUR_1 || '',
    FOURNISSEUR_2: ia.FOURNISSEUR_2 || '',
    FOURNISSEUR_3: ia.FOURNISSEUR_3 || '', FOURNISSEUR_4: ia.FOURNISSEUR_4 || '',
    SOUS_TRAITANT_1: ia.SOUS_TRAITANT_1 || '', SOUS_TRAITANT_2: ia.SOUS_TRAITANT_2 || '',
    DESCRIPTION_TRAVAUX: ia.DESCRIPTION_TRAVAUX || '',
    DETAILS_IMPREVUS: '',
    NUMERO_GARANTIE: '', SURFACE_GARANTIE: ia.SURFACE_GARANTIE || '', DUREE_GARANTIE: ia.DUREE_GARANTIE || '', DATE_FIN_GARANTIE: '',
  };
  for (let i = 1; i <= 9; i++) champs['COMMENTAIRE_' + i] = '';

  // INSERT initial pour obtenir l'id (necessaire pour ranger les documents
  // uploades sous {id}/{categorie}/... dans Supabase Storage)
  const rInsert = await db.execute({
    sql: `INSERT INTO manuels (numero_dossier, titre, contenu, statut, cree_par) VALUES (?, ?, ?, 'brouillon', ?)`,
    args: [champs.NUMERO_DOSSIER, champs.NOM_DU_PROJET || 'Manuel en cours', JSON.stringify({ champs, documents: {}, ia_erreur: iaErreur }), 'T3E'],
  });
  const manuelId = rInsert.lastInsertRowid || 0;

  // Persister chaque categorie de documents uploades (deplace uploads-temp -> manuels-fin-chantier)
  const documents = {};
  for (const { cle } of CATEGORIES_DOCUMENTS) {
    const cles = [].concat(req.body[cle + '_key'] || []);
    const noms = [].concat(req.body[cle + '_name'] || []);
    documents[cle] = await persisterCategorie(manuelId, cle, cles, noms);
  }

  // Les fiches techniques réellement approuvées priment sur le devis pour les
  // fournisseurs (voir extraireFournisseursDepuisFT ci-dessus).
  const fournisseursFT = await extraireFournisseursDepuisFT(documents.fiches_techniques);
  if (fournisseursFT) Object.assign(champs, fournisseursFT);

  // Case a cocher "Brochure marketing" (voir manuel-nouveau.ejs) — cochee par
  // defaut pour preserver le comportement historique (toujours incluse), mais
  // desormais desactivable explicitement.
  const inclureBrochure = req.body.inclure_brochure === '1';

  await db.execute({
    sql: `UPDATE manuels SET contenu = ? WHERE id = ?`,
    args: [JSON.stringify({ champs, documents, ia_erreur: iaErreur, inclure_brochure: inclureBrochure }), manuelId],
  });

  res.redirect('/manuels/reviser/' + manuelId);
});

// ── PAGE DE RÉVISION ──
router.get('/reviser/:id', async (req, res) => {
  const r = await req.db.execute({ sql: 'SELECT * FROM manuels WHERE id = ?', args: [parseInt(req.params.id)] });
  if (r.rows.length === 0) return res.redirect('/manuels');

  const row = r.rows[0];
  let data;
  try { data = JSON.parse(row.contenu); } catch (_) { data = {}; }

  const statutSections = await calculerStatutSections(data.documents || {}, data.non_applicable || {});

  res.render('manuel-reviser', {
    manuel: row,
    champs: data.champs || {},
    documents: data.documents || {},
    iaErreur: data.ia_erreur || '',
    checklistItems: CHECKLIST_ITEMS,
    statutSections,
    // Manuels crees avant l'ajout de cette case a cocher : comportement
    // historique preserve (brochure toujours incluse par defaut).
    inclureBrochure: data.inclure_brochure !== false,
    generation: data.generation || null,
    blocageMessage: '',
  });
});

// ── AJOUTER DES DOCUMENTS à un manuel existant (depuis la page de révision,
//    sans avoir à refaire tout le flux d'upload initial) ──
router.post('/reviser/:id/documents', async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const r = await db.execute({ sql: 'SELECT * FROM manuels WHERE id = ?', args: [id] });
  if (r.rows.length === 0) return res.status(404).send('Manuel introuvable');

  const row = r.rows[0];
  let data;
  try { data = JSON.parse(row.contenu); } catch (_) { data = {}; }
  const documents = data.documents || {};
  let champs = data.champs || {};
  let ftAjoutees = false;

  for (const { cle } of CATEGORIES_DOCUMENTS) {
    const cles = [].concat(req.body[cle + '_key'] || []);
    const noms = [].concat(req.body[cle + '_name'] || []);
    if (cles.length === 0) continue;
    const nouveaux = await persisterCategorie(id, cle, cles, noms);
    documents[cle] = [...(documents[cle] || []), ...nouveaux];
    if (cle === 'fiches_techniques') ftAjoutees = true;
  }

  // Nouvelle(s) fiche(s) technique(s) ajoutée(s) : recalcule les fournisseurs
  // à partir de l'ensemble des FT désormais disponibles (voir /analyser).
  if (ftAjoutees) {
    const fournisseursFT = await extraireFournisseursDepuisFT(documents.fiches_techniques);
    if (fournisseursFT) champs = { ...champs, ...fournisseursFT };
  }

  await db.execute({
    sql: `UPDATE manuels SET contenu = ? WHERE id = ?`,
    args: [JSON.stringify({ ...data, champs, documents }), id],
  });

  res.redirect('/manuels/reviser/' + id);
});

// Sur Vercel (plan Hobby, plafond DUR de 60s par fonction, non modifiable),
// la fusion complete (surtout avec beaucoup de fiches techniques/dessins —
// signale par l'utilisateur avec 27 FT : FUNCTION_INVOCATION_TIMEOUT) peut
// depasser le temps disponible. On delegue alors la generation en
// ARRIERE-PLAN a l'instance Render (meme service que la conversion docx->pdf,
// voir docx-to-pdf.js), mais SANS attendre la fin : on ne recupere que
// l'accuse de reception immediat (202), le traitement continue cote Render
// independamment de la duree de vie de cette fonction serverless — Render est
// un service persistant (pas une fonction a la demande), donc sans ce genre
// de plafond. Voir /internal/generer-manuel (server.js) et
// genererEtSauvegarderManuel (services/manuel-generateur.js).
async function declencherGenerationDistante(id) {
  const url = (process.env.CONVERT_SERVICE_URL || '').trim();
  const secret = (process.env.CONVERT_SERVICE_SECRET || '').trim();
  if (!url || !secret) throw new Error('service distant non configuré (CONVERT_SERVICE_URL/SECRET manquant)');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(url.replace(/\/$/, '') + '/internal/generer-manuel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-convert-secret': secret },
      body: JSON.stringify({ manuelId: id }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const corps = await resp.text().catch(() => '');
      throw new Error(`service distant a répondu ${resp.status}: ${corps.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

// ── GÉNÉRER — remplir le .docx, convertir en PDF, fusionner tous les documents ──
router.post('/generer/:id', express.urlencoded({ extended: true }), async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const r = await db.execute({ sql: 'SELECT * FROM manuels WHERE id = ?', args: [id] });
  if (r.rows.length === 0) return res.status(404).send('Manuel introuvable');

  const row = r.rows[0];
  let data;
  try { data = JSON.parse(row.contenu); } catch (_) { data = {}; }
  const documents = data.documents || {};

  // Champs mis a jour depuis le formulaire de revision
  const champs = {};
  for (const cleChamp of Object.keys(data.champs || {})) {
    champs[cleChamp] = (req.body[cleChamp] || '').trim();
  }
  // Brochure marketing desormais optionnelle (case a cocher) — voir
  // genererEtSauvegarderManuel, qui lit inclure_brochure depuis les donnees
  // sauvegardees plutot que de recevoir la valeur en parametre.
  const inclureBrochure = req.body.inclure_brochure === '1';

  // ── Vérification avant génération (priorité #1) : une section obligatoire
  // manquante ne doit JAMAIS produire un manuel incomplet en silence. Les
  // sections qui le permettent peuvent être marquées "non applicable" AVEC
  // une note obligatoire — sans note, la case ne compte pas.
  const nonApplicables = { ...(data.non_applicable || {}) };
  for (const section of SECTIONS_VERIFICATION) {
    if (!section.peutEtreNonApplicable) continue;
    const coche = req.body['non_applicable_' + section.cle] === '1';
    const note = (req.body['note_non_applicable_' + section.cle] || '').trim();
    if (coche && note) nonApplicables[section.cle] = { note, date: new Date().toISOString() };
    else if (!coche) delete nonApplicables[section.cle];
  }

  const statutSections = await calculerStatutSections(documents, nonApplicables);
  const sectionsBloquantes = statutSections.filter((s) => s.statut === 'manquante' || s.statut === 'defaut_manquant');

  // On sauvegarde toujours les reponses (champs + non-applicables), meme si
  // on bloque — pour ne jamais faire perdre la saisie de l'utilisateur.
  await db.execute({
    sql: `UPDATE manuels SET contenu = ? WHERE id = ?`,
    args: [JSON.stringify({ ...data, champs, documents, non_applicable: nonApplicables, inclure_brochure: inclureBrochure }), id],
  });

  if (sectionsBloquantes.length > 0) {
    return res.render('manuel-reviser', {
      manuel: row,
      champs,
      documents,
      iaErreur: data.ia_erreur || '',
      checklistItems: CHECKLIST_ITEMS,
      statutSections,
      inclureBrochure,
      generation: null,
      blocageMessage: 'Impossible de générer le manuel final : ' + sectionsBloquantes.map((s) => `« ${s.label} » est manquante`).join(', ') + '. Fournissez le document manquant, ou cochez « Non applicable » avec une note si la section ne s\'applique pas à ce projet.',
    });
  }

  if (process.env.VERCEL) {
    try {
      // Marque "en cours" AVANT de declencher, pour que la page de revision
      // (rechargee juste apres la redirection) affiche le bon statut meme si
      // Render n'a pas encore eu le temps de commencer le traitement.
      await db.execute({
        sql: `UPDATE manuels SET contenu = ? WHERE id = ?`,
        args: [JSON.stringify({
          ...data, champs, documents, non_applicable: nonApplicables, inclure_brochure: inclureBrochure,
          generation: { statut: 'en_cours', demarre_le: new Date().toISOString() },
        }), id],
      });
      await declencherGenerationDistante(id);
      return res.redirect('/manuels/reviser/' + id);
    } catch (e) {
      console.error('[manuels] Délégation Render impossible, tentative en local :', e.message);
      // On continue ci-dessous en synchrone plutôt que d'échouer silencieusement
      // — risque de re-timeout sur un gros manuel, mais un manuel de petite
      // taille passera quand même, et l'échec sera visible si ça timeout.
    }
  }

  const resultat = await genererEtSauvegarderManuel(db, id);
  if (!resultat.ok) return res.status(500).send('Erreur : ' + resultat.erreur);
  res.redirect('/manuels/telecharger/' + id);
});

router.get('/telecharger/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const r = await req.db.execute({ sql: 'SELECT numero_dossier FROM manuels WHERE id = ?', args: [id] });
  const numeroDossier = r.rows[0] ? r.rows[0].numero_dossier : null;
  const nomFichier = `Manuel_Fin_Chantier_${(numeroDossier || id).toString().replace(/[^a-zA-Z0-9_-]/g, '-')}.pdf`;
  try {
    const url = await createSignedUrl(BUCKETS.MANUELS, `${id}/manuel-final.pdf`, 300, nomFichier);
    res.redirect(url);
  } catch (e) {
    res.status(404).send('Manuel introuvable ou pas encore genere.');
  }
});

router.post('/supprimer/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  await supprimerDossierManuel(id);
  await req.db.execute({ sql: 'DELETE FROM manuels WHERE id = ?', args: [id] });
  res.redirect('/manuels');
});

// ── SUPPRESSION MULTIPLE — évite de devoir supprimer un par un ──
router.post('/supprimer-plusieurs', async (req, res) => {
  const ids = [].concat(req.body.ids || []).map(id => parseInt(id)).filter(id => !isNaN(id));
  for (const id of ids) {
    await supprimerDossierManuel(id);
    await req.db.execute({ sql: 'DELETE FROM manuels WHERE id = ?', args: [id] });
  }
  res.redirect('/manuels');
});

module.exports = router;
