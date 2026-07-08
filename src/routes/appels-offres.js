const express = require('express');
const router = express.Router();
const path = require('path');
const crypto = require('crypto');
const { PDFDocument } = require('pdf-lib');
const { synchroniser } = require('../services/seao-sync');
const { obtenirInfosEntreprise } = require('../services/seao-autofill');
const {
  remplirFormulaireDocx, remplirFormulairePdfAcroForm, remplirFormulairePdfPlat,
  aplatirInfosEntreprise, NOMS_LISIBLES, genererPageNotePreparation,
} = require('../services/seao-formulaire');
const { fillTemplatePdf } = require('../services/pdf-filler');
const { downloadBuffer, uploadBuffer, removeFile, createSignedUrl, sanitizeKey, BUCKETS } = require('../services/storage');

const STATUTS = ['a_analyser', 'interessant', 'a_soumissionner', 'refuse', 'depose', 'perdu', 'gagne'];
const LABELS_STATUT = {
  a_analyser: 'À analyser', interessant: 'Intéressant', a_soumissionner: 'À soumissionner',
  refuse: 'Refusé', depose: 'Déposé', perdu: 'Perdu', gagne: 'Gagné',
};
const CATEGORIES_DOCUMENTS = ['devis', 'plans', 'addenda', 'formulaire_soumission'];

// Cles generees exclusivement par /api/upload-url (voir bordereaux.js/manuels.js) : jamais de separateur de chemin.
function cleTempValide(key) {
  return typeof key === 'string' && key.length > 0 && !key.includes('/') && !key.includes('..');
}

router.get('/', async (req, res) => {
  const db = req.db;
  const filtre = req.query.filtre || '14j';
  const tri = req.query.tri || 'pertinence';

  // Toujours plafonne a 14 jours (voir demande initiale), le filtre affine dans cette fenetre.
  let intervalle = '-14 day';
  if (filtre === 'aujourdhui') intervalle = '0 day';
  else if (filtre === '24h') intervalle = '-1 day';
  else if (filtre === '7j') intervalle = '-7 day';

  let sql = `SELECT a.*,
      (SELECT COUNT(*) FROM appels_offres_formulaires f WHERE f.appel_offre_id = a.id) as nb_formulaires
      FROM appels_offres_seao a WHERE a.date_publication >= datetime('now', ?)`;
  const args = [intervalle];
  if (req.query.visite === '1') sql += ` AND a.date_visite_obligatoire IS NOT NULL AND a.date_visite_obligatoire != ''`;
  sql += tri === 'fermeture'
    ? ` ORDER BY a.date_fermeture ASC`
    : ` ORDER BY LENGTH(a.mots_cles_matches) - LENGTH(REPLACE(a.mots_cles_matches, ',', '')) DESC, a.date_publication DESC`;

  const r = await db.execute({ sql, args });
  const derniereSync = await db.execute(`SELECT MAX(updated_at) as t FROM appels_offres_seao`);

  res.render('appels-offres', {
    appels: r.rows, filtre, tri,
    derniereSync: derniereSync.rows[0] ? derniereSync.rows[0].t : null,
    syncMsg: req.query.sync || '', syncMatches: req.query.matches || '', syncErreur: req.query.msg || '',
  });
});

router.get('/nouveau', (req, res) => {
  res.render('appel-offre-nouveau', { erreur: '' });
});

// Creation manuelle — necessaire car la synchronisation automatique ne
// capture que les avis correspondant aux mots-cles toiture ; un appel
// d'offres trouve autrement (hors mots-cles, ou avant la prochaine
// synchronisation hebdomadaire) doit pouvoir etre ajoute a la main.
router.post('/nouveau', async (req, res) => {
  const db = req.db;
  const { numero_seao, titre, donneur_ouvrage, lieu_travaux, date_fermeture, date_visite_obligatoire, url_seao } = req.body;
  if (!numero_seao || !titre) {
    return res.render('appel-offre-nouveau', { erreur: 'Le numéro SEAO et le titre sont obligatoires.' });
  }
  try {
    const r = await db.execute({
      sql: `INSERT INTO appels_offres_seao (numero_seao, titre, donneur_ouvrage, lieu_travaux, date_publication, date_fermeture, date_visite_obligatoire, url_seao, mots_cles_matches)
            VALUES (?, ?, ?, ?, datetime('now'), ?, ?, ?, 'ajout manuel')`,
      args: [numero_seao, titre, donneur_ouvrage || null, lieu_travaux || null, date_fermeture || null, date_visite_obligatoire || null, url_seao || null],
    });
    res.redirect('/appels-offres/' + r.lastInsertRowid);
  } catch (e) {
    res.render('appel-offre-nouveau', { erreur: e.message.includes('UNIQUE') ? 'Ce numéro SEAO existe déjà.' : e.message });
  }
});

router.get('/rapide', (req, res) => {
  res.render('appel-offre-formulaire-rapide', { erreur: '' });
});

// Depot rapide d'un formulaire SANS creer/choisir un appel d'offres au
// prealable — cree un appel d'offres minimal en arriere-plan pour reutiliser
// tel quel tout le pipeline existant (formulaire, editeur, remplissage IA),
// puis redirige directement sur la page du formulaire.
router.post('/rapide', async (req, res) => {
  const db = req.db;
  const tempKey = req.body.fichier_key;
  const nomOriginal = req.body.fichier_name || 'formulaire';
  if (!cleTempValide(tempKey)) return res.render('appel-offre-formulaire-rapide', { erreur: 'Fichier manquant ou invalide.' });

  const buf = await downloadBuffer(BUCKETS.UPLOADS_TEMP, tempKey);
  if (!buf) return res.render('appel-offre-formulaire-rapide', { erreur: 'Fichier introuvable dans le stockage temporaire.' });

  const numeroSeao = 'RAPIDE-' + Date.now();
  const rAppel = await db.execute({
    sql: `INSERT INTO appels_offres_seao (numero_seao, titre, date_publication, mots_cles_matches, statut_interne)
          VALUES (?, ?, datetime('now'), 'dépôt rapide', 'a_analyser')`,
    args: [numeroSeao, 'Formulaire déposé rapidement — ' + nomOriginal],
  });
  const appelId = rAppel.lastInsertRowid;

  const cleFinale = sanitizeKey(`${appelId}/formulaire_soumission/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${nomOriginal}`);
  await uploadBuffer(BUCKETS.SEAO, cleFinale, buf);
  await removeFile(BUCKETS.UPLOADS_TEMP, tempKey).catch(() => {});
  await db.execute({
    sql: 'INSERT INTO appels_offres_documents (appel_offre_id, categorie, cle_storage, nom_fichier) VALUES (?, ?, ?, ?)',
    args: [appelId, 'formulaire_soumission', cleFinale, nomOriginal],
  });
  const ext = path.extname(nomOriginal).toLowerCase().replace('.', '');
  const rForm = await db.execute({
    sql: `INSERT INTO appels_offres_formulaires (appel_offre_id, cle_storage_original, format, statut) VALUES (?, ?, ?, 'a_remplir')`,
    args: [appelId, cleFinale, ext],
  });

  res.redirect(`/appels-offres/${appelId}/formulaire/${rForm.lastInsertRowid}`);
});

router.post('/actualiser', async (req, res) => {
  try {
    const resultat = await synchroniser(req.db);
    res.redirect(`/appels-offres?sync=ok&matches=${resultat.matches}`);
  } catch (e) {
    res.redirect(`/appels-offres?sync=erreur&msg=${encodeURIComponent(e.message)}`);
  }
});

router.get('/:id', async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const r = await db.execute({ sql: 'SELECT * FROM appels_offres_seao WHERE id = ?', args: [id] });
  if (r.rows.length === 0) return res.redirect('/appels-offres');

  const documents = await db.execute({ sql: 'SELECT * FROM appels_offres_documents WHERE appel_offre_id = ?', args: [id] });
  const formulaires = await db.execute({ sql: 'SELECT * FROM appels_offres_formulaires WHERE appel_offre_id = ?', args: [id] });

  let donneesBrutes = {};
  try { donneesBrutes = JSON.parse(r.rows[0].donnees_brutes || '{}'); } catch (_) {}

  res.render('appel-offre-detail', {
    appel: r.rows[0], documents: documents.rows, formulaires: formulaires.rows,
    donneesBrutes, statuts: STATUTS, labelsStatut: LABELS_STATUT,
  });
});

router.post('/:id/statut', async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const statut = STATUTS.includes(req.body.statut) ? req.body.statut : 'a_analyser';
  await db.execute({
    sql: `UPDATE appels_offres_seao SET statut_interne = ?, updated_at = datetime('now') WHERE id = ?`,
    args: [statut, id],
  });
  res.redirect('/appels-offres/' + id);
});

// Ajoute un document (devis/plans/addenda/formulaire de soumission) — le
// fichier est deja uploade dans uploads-temp par le navigateur (meme flux
// direct-upload.js que manuels/bordereaux), cette route le deplace vers le
// stockage permanent et cree la ligne DB.
router.post('/:id/documents', async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const categorie = CATEGORIES_DOCUMENTS.includes(req.body.categorie) ? req.body.categorie : 'devis';
  const tempKey = req.body.fichier_key;
  const nomOriginal = req.body.fichier_name || 'document';
  if (!cleTempValide(tempKey)) return res.redirect('/appels-offres/' + id);

  const buf = await downloadBuffer(BUCKETS.UPLOADS_TEMP, tempKey);
  if (buf) {
    const cleFinale = sanitizeKey(`${id}/${categorie}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${nomOriginal}`);
    await uploadBuffer(BUCKETS.SEAO, cleFinale, buf);
    await removeFile(BUCKETS.UPLOADS_TEMP, tempKey).catch(() => {});
    await db.execute({
      sql: 'INSERT INTO appels_offres_documents (appel_offre_id, categorie, cle_storage, nom_fichier) VALUES (?, ?, ?, ?)',
      args: [id, categorie, cleFinale, nomOriginal],
    });
    if (categorie === 'formulaire_soumission') {
      const ext = path.extname(nomOriginal).toLowerCase().replace('.', '');
      await db.execute({
        sql: `INSERT INTO appels_offres_formulaires (appel_offre_id, cle_storage_original, format, statut) VALUES (?, ?, ?, 'a_remplir')`,
        args: [id, cleFinale, ext],
      });
    }
  }
  res.redirect('/appels-offres/' + id);
});

// Supprime un document (et le formulaire lie, le cas echeant, avec son
// eventuel fichier rempli) — necessaire pour retirer un fichier importe par
// erreur sans devoir passer par la base de donnees directement.
router.post('/:id/documents/:docId/supprimer', async (req, res) => {
  const db = req.db;
  const { id, docId } = req.params;
  const r = await db.execute({ sql: 'SELECT * FROM appels_offres_documents WHERE id = ? AND appel_offre_id = ?', args: [docId, id] });
  if (r.rows.length > 0) {
    const doc = r.rows[0];
    await removeFile(BUCKETS.SEAO, doc.cle_storage).catch(() => {});
    const formulairesLies = await db.execute({ sql: 'SELECT * FROM appels_offres_formulaires WHERE appel_offre_id = ? AND cle_storage_original = ?', args: [id, doc.cle_storage] });
    for (const f of formulairesLies.rows) {
      if (f.cle_storage_rempli) await removeFile(BUCKETS.SEAO, f.cle_storage_rempli).catch(() => {});
      await db.execute({ sql: 'DELETE FROM appels_offres_formulaires WHERE id = ?', args: [f.id] });
    }
    await db.execute({ sql: 'DELETE FROM appels_offres_documents WHERE id = ?', args: [docId] });
  }
  res.redirect('/appels-offres/' + id);
});

router.get('/:id/formulaire/:formId', async (req, res) => {
  const db = req.db;
  const { id, formId } = req.params;
  const r = await db.execute({ sql: 'SELECT * FROM appels_offres_formulaires WHERE id = ? AND appel_offre_id = ?', args: [formId, id] });
  if (r.rows.length === 0) return res.redirect('/appels-offres/' + id);
  const appelR = await db.execute({ sql: 'SELECT * FROM appels_offres_seao WHERE id = ?', args: [id] });
  if (appelR.rows.length === 0) return res.redirect('/appels-offres');

  let champsDetectes = [], champsNonPlaces = [];
  try { champsDetectes = JSON.parse(r.rows[0].champs_detectes || '[]'); } catch (_) {}
  try { champsNonPlaces = JSON.parse(r.rows[0].champs_non_places || '[]'); } catch (_) {}

  res.render('appel-offre-formulaire', {
    appel: appelR.rows[0], formulaire: r.rows[0], champsDetectes, champsNonPlaces,
    erreur: req.query.erreur || '',
  });
});

// Sert le PDF ORIGINAL (vierge) — utilise par PDF.js dans l'editeur visuel
// pour l'afficher en canvas (voir /editeur ci-dessous). Jamais le fichier
// rempli : l'editeur sert a POSITIONNER les champs sur le formulaire vide.
router.get('/:id/formulaire/:formId/fichier', async (req, res) => {
  const db = req.db;
  const { id, formId } = req.params;
  const r = await db.execute({ sql: 'SELECT cle_storage_original FROM appels_offres_formulaires WHERE id = ? AND appel_offre_id = ?', args: [formId, id] });
  if (r.rows.length === 0) return res.status(404).send('Formulaire introuvable.');
  const buf = await downloadBuffer(BUCKETS.SEAO, r.rows[0].cle_storage_original);
  if (!buf) return res.status(404).send('Fichier introuvable dans le stockage.');
  res.setHeader('Content-Type', 'application/pdf');
  res.send(buf);
});

// Editeur visuel : meme principe que l'editeur drag-and-drop des bordereaux
// (PDF affiche en canvas via PDF.js, l'utilisateur positionne chaque champ
// lui-meme) — plus fiable que le placement devine par l'IA sur un formulaire
// SEAO typique (lignes a blanc repetees, ex. "Nom du representant :" a
// plusieurs endroits differents du document). Les valeurs sont deja connues
// (base de connaissances) ; l'utilisateur ne fait que choisir OU les ecrire.
router.get('/:id/formulaire/:formId/editeur', async (req, res) => {
  const db = req.db;
  const { id, formId } = req.params;
  const r = await db.execute({ sql: 'SELECT * FROM appels_offres_formulaires WHERE id = ? AND appel_offre_id = ?', args: [formId, id] });
  if (r.rows.length === 0) return res.redirect('/appels-offres/' + id);
  const formulaire = r.rows[0];

  if ((formulaire.format || '').toLowerCase() === 'docx') {
    // L'editeur visuel ne s'applique qu'aux PDF (le .docx a deja son propre
    // pipeline fiable par libelle exact + IA, voir remplirFormulaireDocx).
    return res.redirect(`/appels-offres/${id}/formulaire/${formId}?erreur=${encodeURIComponent("L'éditeur visuel ne s'applique qu'aux formulaires PDF.")}`);
  }

  const appelR = await db.execute({ sql: 'SELECT * FROM appels_offres_seao WHERE id = ?', args: [id] });
  if (appelR.rows.length === 0) return res.redirect('/appels-offres');

  const infos = await obtenirInfosEntreprise(db);
  const valeursConnues = infos.error ? {} : aplatirInfosEntreprise(infos);

  let positions = {};
  try { positions = JSON.parse(formulaire.positions || '{}'); } catch (_) {}

  res.render('appel-offre-formulaire-editeur', {
    appel: appelR.rows[0], formulaire,
    champsDisponibles: Object.keys(NOMS_LISIBLES).map((cle) => ({ cle, label: NOMS_LISIBLES[cle], valeur: valeursConnues[cle] || '' })),
    positions,
  });
});

// Sauvegarde les positions choisies par l'utilisateur (appel fetch JSON
// depuis l'editeur, pas un formulaire classique).
router.post('/:id/formulaire/:formId/positions', async (req, res) => {
  const db = req.db;
  const { id, formId } = req.params;
  const positions = req.body && typeof req.body === 'object' ? req.body : {};
  await db.execute({
    sql: `UPDATE appels_offres_formulaires SET positions = ? WHERE id = ? AND appel_offre_id = ?`,
    args: [JSON.stringify(positions), formId, id],
  });
  res.json({ ok: true });
});

// Pre-remplit le formulaire avec les infos d'entreprise de la base de
// connaissances. Si des positions ont ete placees manuellement via l'editeur
// visuel, elles priment TOUJOURS (bien plus fiable) — sinon, retombe sur la
// detection automatique (.docx / PDF AcroForm / PDF plat par IA).
router.post('/:id/formulaire/:formId/remplir', async (req, res) => {
  const db = req.db;
  const { id, formId } = req.params;
  const r = await db.execute({ sql: 'SELECT * FROM appels_offres_formulaires WHERE id = ? AND appel_offre_id = ?', args: [formId, id] });
  if (r.rows.length === 0) return res.redirect('/appels-offres/' + id);
  const formulaire = r.rows[0];

  try {
    const buf = await downloadBuffer(BUCKETS.SEAO, formulaire.cle_storage_original);
    if (!buf) throw new Error('Fichier original introuvable dans le stockage.');

    // ?recalculer=1 permet de forcer une nouvelle analyse IA sans attendre
    // l'expiration du cache de 30 jours (utile juste apres un ajout/retrait
    // de document dans la base de connaissances).
    const infos = await obtenirInfosEntreprise(db, { forcerRecalcul: req.query.recalculer === '1' });
    if (infos.error) throw new Error(infos.error);

    const ext = (formulaire.format || '').toLowerCase();
    let positionsSauvegardees = {};
    try { positionsSauvegardees = JSON.parse(formulaire.positions || '{}'); } catch (_) {}

    let resultat, formatDetecte;
    if (ext !== 'docx' && Object.keys(positionsSauvegardees).length > 0) {
      // Positionnement manuel (editeur visuel) : le plus fiable, toujours prioritaire.
      const valeursConnues = aplatirInfosEntreprise(infos);
      const positionsAvecValeurs = {};
      const champsPlaces = [], champsNonPlaces = [];
      for (const cle of Object.keys(positionsSauvegardees)) {
        const valeur = valeursConnues[cle];
        if (!valeur) { champsNonPlaces.push(NOMS_LISIBLES[cle] || cle); continue; }
        // Un meme champ peut etre place a plusieurs endroits (ex. nom de
        // l'entreprise repete en page couverture ET en page d'identification
        // d'un vrai formulaire SEAO) — positions[cle] est toujours un tableau.
        const placements = Array.isArray(positionsSauvegardees[cle]) ? positionsSauvegardees[cle] : [positionsSauvegardees[cle]];
        placements.forEach((p, i) => { positionsAvecValeurs[`${cle}#${i}`] = { ...p, val: valeur }; });
        champsPlaces.push(NOMS_LISIBLES[cle] || cle);
      }
      const pdfDoc = await fillTemplatePdf(buf, positionsAvecValeurs);
      resultat = { buffer: Buffer.from(await pdfDoc.save()), champsPlaces, champsNonPlaces };
      formatDetecte = 'pdf_positions_manuelles';
    } else if (ext === 'docx') {
      resultat = await remplirFormulaireDocx(buf, infos);
      formatDetecte = 'docx';
    } else {
      const pdfDoc = await PDFDocument.load(buf);
      const nbChamps = pdfDoc.getForm().getFields().length;
      if (nbChamps > 0) {
        resultat = await remplirFormulairePdfAcroForm(buf, infos);
        formatDetecte = 'pdf_acroform';
      } else {
        resultat = await remplirFormulairePdfPlat(buf, infos);
        formatDetecte = 'pdf_plat';
      }
    }

    // Mises en garde de l'IA (donnee trouvee pour une entite differente,
    // attestation manquante...) — regroupees sur UNE page ajoutee en tete du
    // PDF final plutot que d'annoter le formulaire officiel lui-meme.
    if (formatDetecte !== 'docx' && Array.isArray(infos.AVERTISSEMENTS) && infos.AVERTISSEMENTS.length > 0) {
      try {
        const pdfAvecNote = await PDFDocument.load(resultat.buffer);
        await genererPageNotePreparation(pdfAvecNote, infos.AVERTISSEMENTS);
        resultat.buffer = Buffer.from(await pdfAvecNote.save());
      } catch (e) {
        console.error('[appels-offres] Ajout page de préparation échoué:', e.message);
      }
    }

    const cleRempli = formulaire.cle_storage_original.replace(/(\.[a-z0-9]+)$/i, '-rempli$1');
    await uploadBuffer(BUCKETS.SEAO, cleRempli, resultat.buffer);

    await db.execute({
      sql: `UPDATE appels_offres_formulaires SET cle_storage_rempli = ?, format = ?, champs_detectes = ?, champs_non_places = ?, statut = 'pre_rempli' WHERE id = ?`,
      args: [cleRempli, formatDetecte, JSON.stringify(resultat.champsPlaces), JSON.stringify(resultat.champsNonPlaces), formId],
    });
  } catch (e) {
    console.error('[appels-offres] Remplissage formulaire échoué:', e.message);
    return res.redirect(`/appels-offres/${id}/formulaire/${formId}?erreur=${encodeURIComponent(e.message)}`);
  }
  res.redirect(`/appels-offres/${id}/formulaire/${formId}`);
});

router.get('/:id/formulaire/:formId/telecharger', async (req, res) => {
  const db = req.db;
  const { id, formId } = req.params;
  const r = await db.execute({ sql: 'SELECT * FROM appels_offres_formulaires WHERE id = ? AND appel_offre_id = ?', args: [formId, id] });
  if (r.rows.length === 0 || !r.rows[0].cle_storage_rempli) return res.status(404).send('Formulaire pas encore pré-rempli.');
  try {
    const nomFichier = 'formulaire-rempli' + path.extname(r.rows[0].cle_storage_rempli);
    const url = await createSignedUrl(BUCKETS.SEAO, r.rows[0].cle_storage_rempli, 300, nomFichier);
    res.redirect(url);
  } catch (e) {
    res.status(404).send('Fichier introuvable dans le stockage.');
  }
});

module.exports = router;
