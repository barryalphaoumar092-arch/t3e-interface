const express = require('express');
const router = express.Router();
const path = require('path');
const { downloadBuffer, sanitizeKey, BUCKETS } = require('../services/storage');

const MIME_TYPES = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};
function mimeFor(filename) {
  return MIME_TYPES[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}

router.get('/', async (req, res) => {
  const db = req.db;
  const tab = req.query.tab || 'documents';
  const search = req.query.q || '';
  const catFilter = req.query.categorie || '';

  const categories = await db.execute('SELECT id, nom FROM categories ORDER BY nom');
  const catList = categories.rows.map(r => [r.id, r.nom]);

  let documents = [];
  if (tab === 'documents') {
    let sql = `SELECT d.id, d.titre, d.nom_fichier, c.nom as categorie, d.type_fichier,
               d.source, d.annee, d.description, d.statut, ROUND(d.taille_octets/1048576.0,2) as taille_mb
               FROM documents d JOIN categories c ON d.categorie_id = c.id WHERE d.statut = 'actif'`;
    const args = [];
    if (search) {
      sql += ` AND (d.titre LIKE ? OR d.description LIKE ? OR d.mots_cles LIKE ?)`;
      args.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (catFilter) {
      sql += ` AND c.nom = ?`;
      args.push(catFilter);
    }
    sql += ' ORDER BY c.nom, d.titre';
    const r = await db.execute({ sql, args });
    documents = r.rows;
  }

  let materiaux = [];
  if (tab === 'materiaux') {
    let sql = `SELECT id, nom, fabricant, type_produit, type_systeme, fournisseur, dimension, unite, lien_fiche_technique, lien_fiche_securite FROM materiaux WHERE 1=1`;
    const args = [];
    if (search) {
      sql += ` AND (nom LIKE ? OR fabricant LIKE ? OR type_produit LIKE ? OR type_systeme LIKE ?)`;
      args.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    sql += ' ORDER BY type_produit, fabricant, nom';
    const r = await db.execute({ sql, args });
    materiaux = r.rows.map(row => ({
      ...row, lien_ft: row.lien_fiche_technique, lien_sds: row.lien_fiche_securite
    }));
  }

  let architectes = [];
  if (tab === 'architectes') {
    let sql = `SELECT id, firme, ville, telephone, email, contact, adresse, site_web FROM architectes WHERE 1=1`;
    const args = [];
    if (search) {
      sql += ` AND (firme LIKE ? OR ville LIKE ? OR contact LIKE ?)`;
      args.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    sql += ' ORDER BY firme';
    const r = await db.execute({ sql, args });
    architectes = r.rows;
  }

  res.render('connaissances', { tab, search, catFilter, catList, documents, materiaux, architectes });
});

const MDP_ADMIN = process.env.MDP_APP || 'barry';

// Le fichier est deja uploade DIRECTEMENT vers le bucket Supabase "documents"
// par le navigateur (voir /api/upload-url + views/connaissances.ejs) — cette
// route ne recoit plus que les metadonnees, pour contourner la limite de
// 4.5 Mo par requete des fonctions serverless Vercel.
router.post('/categorie', async (req, res) => {
  if (req.body.mdp_admin !== MDP_ADMIN) return res.redirect('/connaissances?error=mdp');
  const db = req.db;
  const nom = (req.body.nom || '').trim();
  if (!nom) return res.redirect('/connaissances?error=no_nom');
  try {
    await db.execute({
      sql: 'INSERT INTO categories (nom, description) VALUES (?, ?)',
      args: [nom, (req.body.description || '').trim() || null],
    });
  } catch (e) {
    // categorie deja existante (contrainte UNIQUE sur nom) -> pas une erreur utilisateur
    if (!/UNIQUE/i.test(e.message || '')) throw e;
  }
  res.redirect('/connaissances?success=categorie');
});

router.post('/ajouter', async (req, res) => {
  if (req.body.mdp_admin !== MDP_ADMIN) return res.redirect('/connaissances?error=mdp');
  const db = req.db;
  const { titre, categorie_id, description, source, annee, mots_cles, fichier_nom, fichier_taille } = req.body;
  if (!fichier_nom) return res.redirect('/connaissances?error=no_file');

  const ext = path.extname(fichier_nom).toLowerCase().replace('.', '');
  const relativePath = 'documents/' + fichier_nom;
  await db.execute({
    sql: `INSERT INTO documents (titre, nom_fichier, chemin_fichier, categorie_id, type_fichier, taille_octets, description, source, annee, mots_cles)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [titre, fichier_nom, relativePath, parseInt(categorie_id), ext, parseInt(fichier_taille) || 0, description || null, source || null, annee || null, mots_cles || null]
  });
  res.redirect('/connaissances?success=added');
});

// chemin_fichier est normalement "documents/{fichier}" (bucket "documents",
// a plat) -- mais pour certains documents de la base de connaissances (ex :
// fiches techniques deja stockees dans le bucket "fiches-techniques", sous
// des sous-dossiers par fabricant) le premier segment peut designer un AUTRE
// bucket connu. On ne retombe sur le comportement historique (bucket
// "documents", cle = basename) que si ce premier segment n'est pas un bucket
// reconnu, pour ne rien casser sur les documents deja corrects.
const BUCKETS_CONNUS = new Set(Object.values(BUCKETS));
function resoudreBucketEtCle(cheminFichier, nomFichier) {
  const brut = cheminFichier || nomFichier || '';
  const segments = brut.split('/');
  if (segments.length > 1 && BUCKETS_CONNUS.has(segments[0])) {
    return { bucket: segments[0], key: sanitizeKey(segments.slice(1).join('/')) };
  }
  return { bucket: BUCKETS.DOCUMENTS, key: sanitizeKey(path.basename(brut)) };
}

router.get('/fichier/:id', async (req, res) => {
  const db = req.db;
  const r = await db.execute({ sql: 'SELECT nom_fichier, chemin_fichier FROM documents WHERE id = ?', args: [parseInt(req.params.id)] });
  if (r.rows.length === 0) return res.status(404).send('Document introuvable');

  const { nom_fichier, chemin_fichier } = r.rows[0];
  const { bucket, key } = resoudreBucketEtCle(chemin_fichier, nom_fichier);
  const buffer = await downloadBuffer(bucket, key);
  if (!buffer) return res.status(404).send('Fichier introuvable dans le stockage.');

  res.setHeader('Content-Type', mimeFor(nom_fichier));
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(nom_fichier)}"`);
  res.send(buffer);
});

// ── Reparation ponctuelle (a retirer apres execution) ────────────────────
// 126 documents legacy (avant l'ingestion SEAO) avaient un chemin_fichier
// qui ne correspondait a AUCUN fichier reel dans Supabase Storage (soit une
// fiche technique en fait stockee dans le bucket "fiches-techniques" sous un
// sous-dossier fabricant, soit un nom de fichier different du titre affiche).
// Mapping etabli par correspondance de tokens + verification manuelle des
// cas ambigus, puis confirme par telechargement reel de chaque fichier
// candidat avant ecriture en base (voir historique de commit).
const MAPPING_REPARATION_LEGACY = [
  { id: 1, bucket: 'documents', key: 'bulletin_01-la-normalisation-au-canada.pdf' },
  { id: 2, bucket: 'documents', key: 'bulletin_02-isolants-de-couverture.pdf' },
  { id: 3, bucket: 'documents', key: 'bulletin_03-parapets-ventiles.pdf' },
  { id: 4, bucket: 'documents', key: 'bulletin-4-guide-pour-la-rfection-des-couvertures-rv-2023-05-29.pdf' },
  { id: 5, bucket: 'documents', key: 'bulletin_05-ventilation-vides-sous-toits-v.-2023-11-21.pdf' },
  { id: 6, bucket: 'documents', key: 'bulletin_06-inspection-des-travaux-de-couvertures.pdf' },
  { id: 7, bucket: 'documents', key: 'bulletin_07-attaches-mecaniques.pdf' },
  { id: 8, bucket: 'documents', key: 'bulletin_08-membrane-de-bitume-modifie-au-sbs.pdf' },
  { id: 9, bucket: 'documents', key: 'Bulletin-9-Adhesifs-pour-toitures.pdf' },
  { id: 10, bucket: 'documents', key: 'bulletin_10-materiaux-composites.pdf' },
  { id: 11, bucket: 'documents', key: 'Bulletin-11-Toits-vegetalises.pdf' },
  { id: 12, bucket: 'documents', key: 'bulletin-technique-13-2025-01-08.pdf' },
  { id: 13, bucket: 'documents', key: 'Bulletin-14-final.pdf' },
  { id: 14, bucket: 'documents', key: 'Bulletin-15-Trop-pleins-et-dalots-durgence-1.pdf' },
  { id: 15, bucket: 'documents', key: 'Bulletin_16_efficacite_energetique_final-1.pdf' },
  { id: 16, bucket: 'documents', key: 'Bulletin_17_2021_10_27_Gestion_eaux-1.pdf' },
  { id: 17, bucket: 'documents', key: '2024-09-19-bulletin-18-couvertures-entretien-refection-et-code-de-construction_v3.pdf' },
  { id: 18, bucket: 'documents', key: 'amcq_intro_2025_protege.pdf' },
  { id: 19, bucket: 'documents', key: 'amcq_division1-nov2026.pdf' },
  { id: 20, bucket: 'documents', key: 'amcq_division-2_2025.pdf' },
  { id: 21, bucket: 'documents', key: 'amcq_division-3_2025.pdf' },
  { id: 22, bucket: 'documents', key: 'amcq_division-4_2025.pdf' },
  { id: 23, bucket: 'documents', key: 'amcq_division-5a_2025_protege.pdf' },
  { id: 24, bucket: 'documents', key: 'amcq_division-5b_2025_protege.pdf' },
  { id: 25, bucket: 'documents', key: 'amcq_division-6_2025_protege.pdf' },
  { id: 26, bucket: 'documents', key: 'amcq_division-8_2025_protege.pdf' },
  { id: 27, bucket: 'documents', key: '2019-AMCQ-Manuel-dentretien.pdf' },
  { id: 28, bucket: 'documents', key: 'B-1.1_ R. 2.pdf' },
  { id: 29, bucket: 'documents', key: 'NR24-28-2020-fra.pdf' },
  { id: 30, bucket: 'documents', key: 'AERMQ-MANUEL-TECHNIQUE-2024-V.25.06.30.pdf' },
  { id: 31, bucket: 'documents', key: 'DIVISION_VII.pdf' },
  { id: 32, bucket: 'documents', key: 'Liste ARCHITECTES.xlsx' },
  { id: 33, bucket: 'documents', key: 'Liste des materiaux avec sds.xlsx' },
  { id: 34, bucket: 'documents', key: 'Bordereau de transmission de fiche technique.doc' },
  { id: 35, bucket: 'documents', key: 'QC_COUVREURS_2026.pdf' },
  { id: 36, bucket: 'fiches-techniques', key: 'Adseal/TDSF-4580.pdf' },
  { id: 37, bucket: 'fiches-techniques', key: 'BP/bp-garantie-weather-tite-canada-est.pdf' },
  { id: 38, bucket: 'fiches-techniques', key: 'BP/ft-bardeau-depart-rh100n-23-11-2015.pdf' },
  { id: 39, bucket: 'fiches-techniques', key: 'BP/ft-deckgard-11-07-2022.pdf' },
  { id: 40, bucket: 'fiches-techniques', key: 'BP/ft-gripgard-31-12-2012.pdf' },
  { id: 41, bucket: 'fiches-techniques', key: 'BP/ft-mystique-rl621-ouest-18-01-2019.pdf' },
  { id: 42, bucket: 'fiches-techniques', key: 'BP/ft-prodeck-11-07-2022.pdf' },
  { id: 43, bucket: 'fiches-techniques', key: 'BP/ft-signature-rl300-21-08-2023.pdf' },
  { id: 44, bucket: 'fiches-techniques', key: 'BP/ft-weathertex-2014-11-25.pdf' },
  { id: 45, bucket: 'fiches-techniques', key: 'BP/tds-dakota-rt664-18-01-2019.pdf' },
  { id: 46, bucket: 'fiches-techniques', key: 'Canstorm/Canstorm-SA-HT_Brochure_EN-FR-Letter-size (1).pdf' },
  { id: 47, bucket: 'fiches-techniques', key: 'Canstorm/TDS_Canstorm_SA_HT-v2374.pdf' },
  { id: 48, bucket: 'fiches-techniques', key: 'CGC/cgc-securock-ultralight-glass-mat-sheathing-data-sheet-fr-can-FWB2862.pdf' },
  { id: 49, bucket: 'fiches-techniques', key: 'Fiche presentation DA.docx' },
  { id: 50, bucket: 'fiches-techniques', key: 'Henry Bakor/HE570_Polybitume570-05_techdata.pdf' },
  { id: 51, bucket: 'fiches-techniques', key: 'HVAC/072117_JM_HVAC_MicroliteEQ_FSK_Data_Sheet_FRN.pdf' },
  { id: 52, bucket: 'fiches-techniques', key: 'HVAC/TremPro_JS773plus_DS.pdf' },
  { id: 53, bucket: 'fiches-techniques', key: 'Ideal/charte-de-couleur.pdf' },
  { id: 54, bucket: 'fiches-techniques', key: 'IKO/0520023_IKO_TDS_Stormtite_EN.pdf' },
  { id: 55, bucket: 'fiches-techniques', key: 'IKO/0520023_IKO_TDS_Stormtite_FR.pdf' },
  { id: 56, bucket: 'fiches-techniques', key: 'IKO/07.31.13-2.2.2-Bardeaux d_asphalte pour proteger les arrets et faites1.pdf' },
  { id: 57, bucket: 'fiches-techniques', key: 'IKO/342276-GoldShield-FR-1.pdf' },
  { id: 58, bucket: 'fiches-techniques', key: 'IKO/4150005_IKO_TDS_Leading Edge Plus_FR.pdf' },
  { id: 59, bucket: 'fiches-techniques', key: 'IKO/4220XXX_IKO_TDS_Cambridge_FR _1_.pdf' },
  { id: 60, bucket: 'fiches-techniques', key: 'IKO/4973XXX-4974XXX_IKO_TDS_Dynasty_FR.pdf' },
  { id: 61, bucket: 'fiches-techniques', key: 'IKO/4998-4999-5010XXX_IKO_TDS_H_R 12-Class 4_FR.pdf' },
  { id: 62, bucket: 'fiches-techniques', key: 'IKO/7910008_IKO_TDS_GoldShield_FR.pdf' },
  { id: 63, bucket: 'fiches-techniques', key: 'IKO/7910046_IKO_TDS_StormShield_FR.pdf' },
  { id: 64, bucket: 'fiches-techniques', key: 'JM/rs-5010-fesco-board-data-sheet.pdf' },
  { id: 65, bucket: 'fiches-techniques', key: 'JM/rs-5047-half-inch-retro-fit-board-data-sheet.pdf' },
  { id: 66, bucket: 'fiches-techniques', key: 'Lexmat/ft-bobinedeclous-lexmat.pdf' },
  { id: 67, bucket: 'fiches-techniques', key: 'Murphco/07.murphco_manchon_pre_moule.pdf' },
  { id: 68, bucket: 'fiches-techniques', key: 'Murphco/16.MURPHCO-Drain-de-cuivre-Ultra-Mek-Dome-fev-2026.pdf' },
  { id: 69, bucket: 'fiches-techniques', key: 'Murphco/19.drain_de_cuivre_ultra_dome.pdf' },
  { id: 70, bucket: 'fiches-techniques', key: 'Murphco/U-FLOW.pdf' },
  { id: 71, bucket: 'fiches-techniques', key: 'Optimum/OPTI-KFA96_FR.pdf' },
  { id: 72, bucket: 'fiches-techniques', key: 'Optimum/OPTI-TA100_FR.pdf' },
  { id: 73, bucket: 'fiches-techniques', key: 'Securpan/5103_fr_v_fibre-de-bois-ignifuge.pdf' },
  { id: 74, bucket: 'fiches-techniques', key: 'Securpan/sopca-fr-ca-tds-soprastar-gr.pdf' },
  { id: 75, bucket: 'fiches-techniques', key: 'Securpan/T12669-100_Securpan_Fr_08-15.pdf' },
  { id: 76, bucket: 'fiches-techniques', key: 'Sico/SC_870130_CAFR.pdf' },
  { id: 77, bucket: 'fiches-techniques', key: 'Soprema/ChemCurb French 07162020.pdf' },
  { id: 78, bucket: 'fiches-techniques', key: 'Soprema/sopca-en-ca-tds-alsan-flashing.pdf' },
  { id: 79, bucket: 'fiches-techniques', key: 'Soprema/sopca-en-ca-tds-colply-ef-flashing-cement.pdf' },
  { id: 80, bucket: 'fiches-techniques', key: 'Soprema/sopca-en-ca-tds-colply-ef.pdf' },
  { id: 81, bucket: 'fiches-techniques', key: 'Soprema/sopca-en-ca-tds-colply-traffic-cap.pdf' },
  { id: 82, bucket: 'fiches-techniques', key: 'Soprema/sopca-en-ca-tds-sopralap-stick.pdf' },
  { id: 83, bucket: 'fiches-techniques', key: 'Soprema/sopca-en-ca-tds-sopramastic-block.pdf' },
  { id: 84, bucket: 'fiches-techniques', key: 'Soprema/sopca-fr-ca-tds-2-1-soprasmart-iso-hd - Copie.pdf' },
  { id: 85, bucket: 'fiches-techniques', key: 'Soprema/sopca-fr-ca-tds-2-1-soprasmart-iso-hd-sanded.pdf' },
  { id: 86, bucket: 'fiches-techniques', key: 'Soprema/sopca-fr-ca-tds-2-1-soprasmart-iso-hd.pdf' },
  { id: 87, bucket: 'fiches-techniques', key: 'Soprema/sopca-fr-ca-tds-colvent-base-830.pdf' },
  { id: 88, bucket: 'fiches-techniques', key: 'Soprema/sopca-fr-ca-tds-duotack.pdf' },
  { id: 89, bucket: 'fiches-techniques', key: 'Soprema/sopca-fr-ca-tds-elastocol-500.pdf' },
  { id: 90, bucket: 'fiches-techniques', key: 'Soprema/sopca-fr-ca-tds-elastocol-stick.pdf' },
  { id: 91, bucket: 'fiches-techniques', key: 'Soprema/sopca-fr-ca-tds-sopra-iso-plus.pdf' },
  { id: 92, bucket: 'fiches-techniques', key: 'Soprema/sopca-fr-ca-tds-sopra-iso-tapered.pdf' },
  { id: 93, bucket: 'fiches-techniques', key: 'Soprema/sopca-fr-ca-tds-sopra-iso.pdf' },
  { id: 94, bucket: 'fiches-techniques', key: 'Soprema/sopca-fr-ca-tds-sopraboard.pdf' },
  { id: 95, bucket: 'fiches-techniques', key: 'Soprema/sopca-fr-ca-tds-soprafelt-no15.pdf' },
  { id: 96, bucket: 'fiches-techniques', key: 'Soprema/sopca-fr-ca-tds-soprafix-base-635.pdf' },
  { id: 97, bucket: 'fiches-techniques', key: 'Soprema/sopca-fr-ca-tds-soprajoint-plus.pdf' },
  { id: 98, bucket: 'fiches-techniques', key: 'Soprema/sopca-fr-ca-tds-sopralap.pdf' },
  { id: 99, bucket: 'fiches-techniques', key: 'Soprema/sopca-fr-ca-tds-sopralene-flam-180.pdf' },
  { id: 100, bucket: 'fiches-techniques', key: 'Soprema/sopca-fr-ca-tds-sopralene-flam-250-gr.pdf' },
  { id: 101, bucket: 'fiches-techniques', key: 'Soprema/sopca-fr-ca-tds-sopramastic.pdf' },
  { id: 102, bucket: 'fiches-techniques', key: 'Soprema/sopca-fr-ca-tds-sopraply-flam-stick.pdf' },
  { id: 103, bucket: 'fiches-techniques', key: 'Soprema/sopca-fr-ca-tds-sopraply-stick-duo.pdf' },
  { id: 104, bucket: 'fiches-techniques', key: 'Soprema/sopca-fr-ca-tds-sopraseal-stick-1100t.pdf' },
  { id: 105, bucket: 'fiches-techniques', key: 'Soprema/sopca-fr-ca-tds-soprastar-flam-gr.pdf' },
  { id: 106, bucket: 'fiches-techniques', key: 'Soprema/sopca-fr-ca-tds-soprastar-gr _1_.pdf' },
  { id: 107, bucket: 'fiches-techniques', key: 'Soprema/sopca-fr-ca-tds-sopravapr.pdf' },
  { id: 108, bucket: 'fiches-techniques', key: 'Soprema/sopca-fr-ca-tds-soprawalk.pdf' },
  { id: 109, bucket: 'fiches-techniques', key: 'Soprema/sopca-fr-ca-tds-soprema-screws-and-plates.pdf' },
  { id: 110, bucket: 'fiches-techniques', key: 'Soprema/technicalbulletin-duotack365.pdf' },
  { id: 111, bucket: 'fiches-techniques', key: 'Thirico/THIROCO-T-20-TECHINCAL-SAFETY-DATA-SHEET_compressed.pdf' },
  { id: 112, bucket: 'fiches-techniques', key: 'Tremco/Dymonic_100_DS.pdf' },
  { id: 113, bucket: 'fiches-techniques', key: 'Unifix/Unifix_Technical Data Sheet_PermaBASE DEK_Canadian_French.pdf' },
  { id: 114, bucket: 'fiches-techniques', key: 'Ventilation Maximum/ft-vmax-301.pdf' },
  { id: 115, bucket: 'fiches-techniques', key: 'Ventilation Maximum/vmax-301-fiche-technique-2025.pdf' },
  { id: 116, bucket: 'fiches-techniques', key: 'Ventilation Maximum/vmax-302-fiche-technique-2025.pdf' },
  { id: 117, bucket: 'fiches-techniques', key: 'Ventilation Maximum/vmax-at1-1224-f-ft-2025.pdf' },
  { id: 118, bucket: 'fiches-techniques', key: 'Ventilation Maximum/vmax-at1-1836-f-ft-2025.pdf' },
  { id: 119, bucket: 'fiches-techniques', key: 'Ventilation Maximum/vmax-at1-895-1213-df-ft-2025.pdf' },
  { id: 120, bucket: 'fiches-techniques', key: 'Ventilation Maximum/vmax-at1-LS.pdf' },
  { id: 121, bucket: 'fiches-techniques', key: 'Ventilation Maximum/vmax-cathedral.pdf' },
  { id: 122, bucket: 'fiches-techniques', key: 'Ventilation Maximum/vmax-cathedrale-fiche-technique-2025.pdf' },
  { id: 123, bucket: 'fiches-techniques', key: 'Ventilation Maximum/Vmax302.pdf' },
  { id: 124, bucket: 'fiches-techniques', key: 'Ventilation Maximum/vmaxcathedral.pdf' },
  { id: 125, bucket: 'fiches-techniques', key: 'Event/24.manchon_inclinable_vent2000.pdf' },
  { id: 126, bucket: 'fiches-techniques', key: 'Event/T3E20- EVENT ALUMINIUM 5 PO.pdf' },
];

router.post('/_reparer-legacy', async (req, res) => {
  if (req.body.mdp_admin !== MDP_ADMIN) return res.status(403).json({ error: 'mdp_admin invalide' });
  const db = req.db;
  const resultats = [];
  for (const m of MAPPING_REPARATION_LEGACY) {
    const buf = await downloadBuffer(m.bucket, m.key);
    if (!buf) { resultats.push({ id: m.id, ok: false, raison: 'fichier candidat introuvable' }); continue; }
    await db.execute({ sql: 'UPDATE documents SET chemin_fichier = ? WHERE id = ?', args: [`${m.bucket}/${m.key}`, m.id] });
    resultats.push({ id: m.id, ok: true });
  }
  const echecs = resultats.filter((r) => !r.ok);
  res.json({ total: resultats.length, ok: resultats.length - echecs.length, echecs });
});

router.post('/supprimer/:id', async (req, res) => {
  if (req.body.mdp_admin !== MDP_ADMIN) return res.redirect('/connaissances?error=mdp');
  const db = req.db;
  await db.execute({
    sql: `UPDATE documents SET statut = 'supprime' WHERE id = ?`,
    args: [parseInt(req.params.id)]
  });
  res.redirect('/connaissances?success=removed');
});

module.exports = router;
