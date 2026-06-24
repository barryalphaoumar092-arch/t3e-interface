const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const { generateSoumission, listTemplates, selectTemplate } = require('../services/soumission-generator');
const { parseDevis, extractProjectInfo } = require('../services/document-parser');

const uploadDevis = multer({ dest: path.join(__dirname, '../../uploads'), limits: { fileSize: 20 * 1024 * 1024 } });

const SYSTEMES = [
  { value: 'BUR', label: 'BUR - Asphalte et Gravier (2-4-5 plis)' },
  { value: 'SOPRASMART', label: 'Soprasmart - Panneau Laminé' },
  { value: 'SOPRAFIX', label: 'Soprafix - Fixation Mécanique' },
  { value: 'COLVENT', label: 'Colvent' },
  { value: 'EPDM_PVC', label: 'EPDM / PVC' },
  { value: 'TPO_PVC_RHINOBOND', label: 'TPO / PVC Rhinobond' },
  { value: 'INVERSE', label: 'Toiture Inversée' },
  { value: 'ANCESTRAL', label: 'Ancestral / Patrimonial' },
];

const TYPES_TRAVAUX = [
  { value: 'REFECTION', label: 'Réfection complète' },
  { value: 'PLEUMAGE', label: 'Pleumage (réfection partielle)' },
];

const PONTAGES = [
  { value: 'bois', label: 'Bois' },
  { value: 'acier', label: 'Acier' },
  { value: 'béton', label: 'Béton' },
  { value: 'siporex', label: 'Siporex' },
];

const TYPES_SOUMISSION = [
  { value: 'prive', label: 'Client Privé' },
  { value: 'bsdq', label: 'BSDQ' },
  { value: 'patrimonial', label: 'Patrimonial' },
];

const GARANTIES_T3E = [
  { value: '5 ans', label: '5 ans' },
  { value: '10 ans', label: '10 ans' },
  { value: '15 ans', label: '15 ans' },
  { value: '20 ans', label: '20 ans' },
];

const GARANTIES_MANUF = [
  { value: '10 ans', label: '10 ans' },
  { value: '15 ans', label: '15 ans' },
  { value: '20 ans', label: '20 ans' },
  { value: '25 ans', label: '25 ans' },
];

function v(val) {
  if (val === undefined || val === null || val === '') return null;
  return val;
}

async function genererNumero(db) {
  const annee = new Date().getFullYear().toString().slice(-2);
  const result = await db.execute(
    "SELECT numero FROM soumissions WHERE numero LIKE ? ORDER BY numero DESC LIMIT 1",
    [`T3E-${annee}-%`]
  );
  let seq = 1;
  if (result.rows.length > 0) {
    const last = result.rows[0].numero;
    const parts = last.split('-');
    seq = parseInt(parts[2] || '0', 10) + 1;
  }
  return `T3E-${annee}-${String(seq).padStart(4, '0')}`;
}

// Liste des soumissions
router.get('/', async (req, res) => {
  const db = req.db;
  const filtre = req.query.statut || '';
  const recherche = req.query.q || '';

  let sql = 'SELECT * FROM soumissions';
  const conditions = [];
  const params = [];

  if (filtre) {
    conditions.push('statut = ?');
    params.push(filtre);
  }
  if (recherche) {
    conditions.push('(client_nom LIKE ? OR projet_nom LIKE ? OR numero LIKE ?)');
    params.push(`%${recherche}%`, `%${recherche}%`, `%${recherche}%`);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY updated_at DESC';

  const result = await db.execute(sql, params);

  const statsResult = await db.execute(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN statut = 'brouillon' THEN 1 ELSE 0 END) as brouillons,
      SUM(CASE WHEN statut = 'genere' THEN 1 ELSE 0 END) as generes,
      SUM(CASE WHEN statut = 'approuve' THEN 1 ELSE 0 END) as approuves,
      SUM(CASE WHEN statut = 'envoye' THEN 1 ELSE 0 END) as envoyes
    FROM soumissions
  `);

  res.render('soumissions', {
    soumissions: result.rows,
    stats: statsResult.rows[0],
    filtre,
    recherche,
  });
});

// Formulaire nouvelle soumission
router.get('/nouveau', async (req, res) => {
  const db = req.db;
  const numero = await genererNumero(db);

  res.render('soumission-nouveau', {
    numero,
    systemes: SYSTEMES,
    types_travaux: TYPES_TRAVAUX,
    pontages: PONTAGES,
    types_soumission: TYPES_SOUMISSION,
    garanties_t3e: GARANTIES_T3E,
    garanties_manuf: GARANTIES_MANUF,
    templates: listTemplates(),
  });
});

// Créer la soumission
router.post('/nouveau', uploadDevis.single('devis'), async (req, res) => {
  const db = req.db;
  const d = req.body;

  // Si un devis a été uploadé, extraire les infos
  if (req.file) {
    try {
      const parsed = await parseDevis(req.file.path, req.file.originalname);
      const devisTexte = parsed.text || '';
      const info = extractProjectInfo(devisTexte);

      if (!d.client_nom && info.client) d.client_nom = info.client;
      if (!d.projet_nom && info.client) d.projet_nom = info.client;
      if (!d.client_adresse && info.adresse) d.client_adresse = info.adresse;
      if (!d.projet_adresse && info.adresse) d.projet_adresse = info.adresse;

      // Extraire plus d'infos du devis
      const supMatch = devisTexte.match(/(\d[\d\s,.]*)\s*(?:pi(?:eds)?[\s²2]|sq\.?\s*f|square\s*f)/i);
      if (supMatch && !d.superficie_pc) d.superficie_pc = supMatch[1].replace(/\s/g, '').replace(',', '');

      const drainMatch = devisTexte.match(/(\d+)\s*(?:drain|drains)/i);
      if (drainMatch && !d.nb_drains) d.nb_drains = drainMatch[1];

      const villeMatch = devisTexte.match(/(?:ville|city)\s*[:#]?\s*([^\n]{3,30})/i);
      if (villeMatch && !d.client_ville) d.client_ville = villeMatch[1].trim();

      const telMatch = devisTexte.match(/(\d{3}[-.\s]\d{3}[-.\s]\d{4})/);
      if (telMatch && !d.client_telephone) d.client_telephone = telMatch[1];

      const emailMatch = devisTexte.match(/[\w.-]+@[\w.-]+\.\w+/);
      if (emailMatch && !d.client_courriel) d.client_courriel = emailMatch[0];

      d._documents_recus = req.file.originalname;
    } catch (err) {
      console.error('Erreur parsing devis soumission:', err.message);
    }
  }

  // Auto-sélectionner le type de soumission (défaut: privé)
  if (!d.type_soumission) d.type_soumission = 'prive';

  if (!d.client_nom || !d.client_nom.trim()) d.client_nom = d.projet_nom || 'Client sans nom';
  if (!d.systeme_toiture) d.systeme_toiture = 'BUR';
  if (!d.type_travaux) d.type_travaux = 'REFECTION';

  const numero = d.numero || await genererNumero(db);
  const templateKey = selectTemplate(d.systeme_toiture || '', d.type_travaux || '');

  await db.execute(`
    INSERT INTO soumissions (
      numero, client_nom, client_adresse, client_ville, client_province, client_code_postal,
      client_contact, client_telephone, client_courriel,
      projet_nom, projet_adresse, systeme_toiture, type_travaux, langue, type_soumission,
      superficie_pc, pontage, epaisseur_isolant, pente_isolant,
      nb_drains, nb_manchons_events, nb_manchons_etancheite, nb_cols_cygne,
      ventilateur_max, cout_remplacement_cp, cout_remplacement_isolant,
      prix_total, garantie_t3e, garantie_manufacturier,
      exclusions_specifiques, documents_recus, notes, template_utilise, cree_par
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `, [
    numero, v(d.client_nom) || 'Client sans nom', v(d.client_adresse), v(d.client_ville), v(d.client_province) || 'QC', v(d.client_code_postal),
    v(d.client_contact), v(d.client_telephone), v(d.client_courriel),
    v(d.projet_nom), v(d.projet_adresse), v(d.systeme_toiture) || 'BUR', v(d.type_travaux) || 'REFECTION', v(d.langue) || 'FR', v(d.type_soumission) || 'prive',
    v(d.superficie_pc), v(d.pontage), v(d.epaisseur_isolant), v(d.pente_isolant),
    v(d.nb_drains), v(d.nb_manchons_events), v(d.nb_manchons_etancheite), v(d.nb_cols_cygne),
    v(d.ventilateur_max), v(d.cout_remplacement_cp), v(d.cout_remplacement_isolant),
    v(d.prix_total), v(d.garantie_t3e) || '5 ans', v(d.garantie_manufacturier) || '10 ans',
    v(d.exclusions_specifiques), v(d.documents_recus || d._documents_recus), v(d.notes), v(templateKey), v(d.cree_par) || 'Estimateur'
  ]);

  const created = await db.execute('SELECT id FROM soumissions WHERE numero = ?', [numero]);
  res.redirect(`/soumissions/${created.rows[0].id}`);
});

// Détail d'une soumission
router.get('/:id', async (req, res) => {
  const db = req.db;
  const result = await db.execute('SELECT * FROM soumissions WHERE id = ?', [req.params.id]);
  if (result.rows.length === 0) return res.redirect('/soumissions');

  const soumission = result.rows[0];

  res.render('soumission-detail', {
    soumission,
    systemes: SYSTEMES,
    types_travaux: TYPES_TRAVAUX,
    pontages: PONTAGES,
    types_soumission: TYPES_SOUMISSION,
    garanties_t3e: GARANTIES_T3E,
    garanties_manuf: GARANTIES_MANUF,
  });
});

// Modifier une soumission
router.post('/:id/modifier', async (req, res) => {
  const db = req.db;
  const d = req.body;
  const templateKey = selectTemplate(d.systeme_toiture || '', d.type_travaux || '');

  await db.execute(`
    UPDATE soumissions SET
      client_nom=?, client_adresse=?, client_ville=?, client_province=?, client_code_postal=?,
      client_contact=?, client_telephone=?, client_courriel=?,
      projet_nom=?, projet_adresse=?, systeme_toiture=?, type_travaux=?, langue=?, type_soumission=?,
      superficie_pc=?, pontage=?, epaisseur_isolant=?, pente_isolant=?,
      nb_drains=?, nb_manchons_events=?, nb_manchons_etancheite=?, nb_cols_cygne=?,
      ventilateur_max=?, cout_remplacement_cp=?, cout_remplacement_isolant=?,
      prix_total=?, garantie_t3e=?, garantie_manufacturier=?,
      exclusions_specifiques=?, documents_recus=?, notes=?, template_utilise=?,
      updated_at=datetime('now')
    WHERE id=?
  `, [
    v(d.client_nom), v(d.client_adresse), v(d.client_ville), v(d.client_province) || 'QC', v(d.client_code_postal),
    v(d.client_contact), v(d.client_telephone), v(d.client_courriel),
    v(d.projet_nom), v(d.projet_adresse), v(d.systeme_toiture), v(d.type_travaux), v(d.langue) || 'FR', v(d.type_soumission) || 'prive',
    v(d.superficie_pc), v(d.pontage), v(d.epaisseur_isolant), v(d.pente_isolant),
    v(d.nb_drains), v(d.nb_manchons_events), v(d.nb_manchons_etancheite), v(d.nb_cols_cygne),
    v(d.ventilateur_max), v(d.cout_remplacement_cp), v(d.cout_remplacement_isolant),
    v(d.prix_total), v(d.garantie_t3e) || '5 ans', v(d.garantie_manufacturier) || '10 ans',
    v(d.exclusions_specifiques), v(d.documents_recus), v(d.notes), v(templateKey),
    req.params.id
  ]);

  res.redirect(`/soumissions/${req.params.id}`);
});

// Générer le document Word
router.post('/:id/generer', async (req, res) => {
  const db = req.db;
  const result = await db.execute('SELECT * FROM soumissions WHERE id = ?', [req.params.id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Soumission introuvable' });

  const soumission = result.rows[0];

  try {
    const generated = await generateSoumission(soumission);

    await db.execute(
      "UPDATE soumissions SET fichier_genere=?, template_utilise=?, statut='genere', updated_at=datetime('now') WHERE id=?",
      [generated.filename, generated.templateUsed, req.params.id]
    );

    res.redirect(`/soumissions/${req.params.id}`);
  } catch (err) {
    res.render('soumission-detail', {
      soumission: { ...soumission, _erreur: err.message },
      systemes: SYSTEMES, types_travaux: TYPES_TRAVAUX, pontages: PONTAGES,
      types_soumission: TYPES_SOUMISSION, garanties_t3e: GARANTIES_T3E, garanties_manuf: GARANTIES_MANUF,
    });
  }
});

// Télécharger le fichier généré
router.get('/:id/telecharger', async (req, res) => {
  const db = req.db;
  const result = await db.execute('SELECT fichier_genere, numero FROM soumissions WHERE id = ?', [req.params.id]);
  if (result.rows.length === 0 || !result.rows[0].fichier_genere) {
    return res.status(404).send('Fichier non trouvé');
  }

  const filePath = path.join(__dirname, '../../uploads/soumissions', result.rows[0].fichier_genere);
  const downloadName = `Soumission_${result.rows[0].numero}.docx`;
  res.download(filePath, downloadName);
});

// Changer le statut
router.post('/:id/statut', async (req, res) => {
  const db = req.db;
  const { statut, approuve_par } = req.body;
  const validStatuts = ['brouillon', 'genere', 'revise', 'approuve', 'envoye'];
  if (!validStatuts.includes(statut)) return res.status(400).send('Statut invalide');

  let sql = "UPDATE soumissions SET statut=?, updated_at=datetime('now')";
  const params = [statut];

  if (statut === 'approuve' && approuve_par) {
    sql += ', approuve_par=?';
    params.push(approuve_par);
  }
  sql += ' WHERE id=?';
  params.push(req.params.id);

  await db.execute(sql, params);
  res.redirect(`/soumissions/${req.params.id}`);
});

// Supprimer
router.post('/:id/supprimer', async (req, res) => {
  const db = req.db;
  await db.execute('DELETE FROM soumissions WHERE id = ?', [req.params.id]);
  res.redirect('/soumissions');
});

// API: template preview
router.get('/api/template-preview', (req, res) => {
  const { systeme, type_travaux } = req.query;
  const key = selectTemplate(systeme || '', type_travaux || '');
  if (!key) return res.json({ found: false });
  const templates = listTemplates();
  const tpl = templates.find(t => t.key === key);
  res.json({ found: true, ...tpl });
});

module.exports = router;
