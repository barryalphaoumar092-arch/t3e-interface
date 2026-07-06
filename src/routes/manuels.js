const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { parseDevis } = require('../services/document-parser');
const { remplirManuel } = require('../services/manuel-filler');
const { convertirDocxEnPdf } = require('../services/docx-to-pdf');
const { analyserDevisManuel } = require('../services/claude-client');
const { PDFDocument } = require('pdf-lib');
const { downloadBuffer, uploadBuffer, createSignedUrl, removeFile, listFiles, sanitizeKey, BUCKETS } = require('../services/storage');

// Documents par defaut (reutilises sur tous les manuels, sauf remplacement
// projet par projet) — a uploader une fois dans le bucket "documents" via la
// page Connaissances.
const DEFAUTS = {
  manuel_entretien: 'manuels-defauts/manuel-entretien-preventif.pdf',
  attestation_cnesst: 'manuels-defauts/attestation-cnesst.pdf',
  attestation_ccq: 'manuels-defauts/attestation-ccq.pdf',
};

// Categories de documents uploades par l'utilisateur, dans l'ORDRE de fusion
// du sommaire (voir plan). "multiple: true" = plusieurs fichiers possibles.
const CATEGORIES_DOCUMENTS = [
  { cle: 'dessins_atelier', multiple: true },
  { cle: 'fiches_techniques', multiple: true },
  { cle: 'plans_as_built', multiple: true },
  { cle: 'garantie_fabricant', multiple: false },
  { cle: 'attestation_cnesst', multiple: false },
  { cle: 'attestation_ccq', multiple: false },
  { cle: 'plan', multiple: true },
];

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

async function fusionnerPdfBuffers(buffers) {
  const merged = await PDFDocument.create();
  for (const buf of buffers) {
    try {
      const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
      (await merged.copyPages(doc, doc.getPageIndices())).forEach(pg => merged.addPage(pg));
    } catch (e) {
      console.error('[manuels] Erreur fusion PDF:', e.message);
    }
  }
  return merged.getPageCount() > 0 ? Buffer.from(await merged.save()) : null;
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

  await db.execute({
    sql: `UPDATE manuels SET contenu = ? WHERE id = ?`,
    args: [JSON.stringify({ champs, documents, ia_erreur: iaErreur }), manuelId],
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

  res.render('manuel-reviser', {
    manuel: row,
    champs: data.champs || {},
    documents: data.documents || {},
    iaErreur: data.ia_erreur || '',
    checklistItems: CHECKLIST_ITEMS,
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

  for (const { cle } of CATEGORIES_DOCUMENTS) {
    const cles = [].concat(req.body[cle + '_key'] || []);
    const noms = [].concat(req.body[cle + '_name'] || []);
    if (cles.length === 0) continue;
    const nouveaux = await persisterCategorie(id, cle, cles, noms);
    documents[cle] = [...(documents[cle] || []), ...nouveaux];
  }

  await db.execute({
    sql: `UPDATE manuels SET contenu = ? WHERE id = ?`,
    args: [JSON.stringify({ ...data, documents }), id],
  });

  res.redirect('/manuels/reviser/' + id);
});

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

  let docxBuf;
  try {
    docxBuf = await remplirManuel(champs);
  } catch (e) {
    return res.status(500).send('Erreur lors du remplissage du manuel : ' + e.message);
  }

  let manuelPdfBuf;
  try {
    manuelPdfBuf = await convertirDocxEnPdf(docxBuf);
  } catch (e) {
    return res.status(500).send('Erreur lors de la conversion PDF du manuel (le .docx genere est disponible mais pas la fusion complete) : ' + e.message);
  }

  // Fusion dans l'ordre du sommaire
  const buffersAFusionner = [manuelPdfBuf];
  const manuelEntretienBuf = await downloadBuffer(BUCKETS.DOCUMENTS, DEFAUTS.manuel_entretien);
  if (manuelEntretienBuf) buffersAFusionner.push(manuelEntretienBuf);
  buffersAFusionner.push(...(await chargerAvecDefaut(documents.attestation_cnesst, DEFAUTS.attestation_cnesst)));
  buffersAFusionner.push(...(await chargerAvecDefaut(documents.attestation_ccq, DEFAUTS.attestation_ccq)));
  buffersAFusionner.push(...(await chargerBuffersCategorie(documents.garantie_fabricant)));
  buffersAFusionner.push(...(await chargerBuffersCategorie(documents.dessins_atelier)));
  buffersAFusionner.push(...(await chargerBuffersCategorie(documents.plan)));
  buffersAFusionner.push(...(await chargerBuffersCategorie(documents.fiches_techniques)));
  buffersAFusionner.push(...(await chargerBuffersCategorie(documents.plans_as_built)));

  const pdfFinal = await fusionnerPdfBuffers(buffersAFusionner);
  if (!pdfFinal) return res.status(500).send('Aucune page generee — verifiez le template et les documents uploades.');

  await uploadBuffer(BUCKETS.MANUELS, `${id}/manuel-final.pdf`, pdfFinal, 'application/pdf').catch(() => {});

  await db.execute({
    sql: `UPDATE manuels SET statut = 'approuve', contenu = ?, titre = ?, numero_dossier = ? WHERE id = ?`,
    args: [JSON.stringify({ champs, documents, ia_erreur: data.ia_erreur || '' }), champs.NOM_DU_PROJET || row.titre, champs.NUMERO_DOSSIER || row.numero_dossier, id],
  });

  // Redirection vers une URL signee Supabase plutot que d'envoyer le buffer
  // dans la reponse : un manuel avec beaucoup de fiches techniques/dessins
  // depasse facilement les 4.5 Mo de limite de reponse d'une fonction
  // serverless Vercel (meme limite que pour l'upload — voir storage.js).
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

module.exports = router;
