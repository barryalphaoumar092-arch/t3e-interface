const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
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

// API: template preview (DOIT être avant /:id pour ne pas être intercepté)
router.get('/api/template-preview', (req, res) => {
  const { systeme, type_travaux } = req.query;
  const key = selectTemplate(systeme || '', type_travaux || '');
  if (!key) return res.json({ found: false });
  const templates = listTemplates();
  const tpl = templates.find(t => t.key === key);
  res.json({ found: true, ...tpl });
});

// ÉTAPE 1 : Formulaire initial (upload devis + infos de base)
router.get('/nouveau', async (req, res) => {
  const db = req.db;
  const numero = await genererNumero(db);
  const { isConfigured } = require('../services/claude-client');

  res.render('soumission-etape1', {
    numero,
    types_travaux: TYPES_TRAVAUX,
    iaActive: isConfigured(),
  });
});

// ÉTAPE 1→2 : Analyser le devis et créer la soumission brouillon
router.post('/analyser', uploadDevis.single('devis'), async (req, res) => {
  const db = req.db;
  const d = req.body || {};
  const { isConfigured, analyserDevis } = require('../services/claude-client');

  let devisTexte = '';
  if (req.file) {
    try {
      const parsed = await parseDevis(req.file.path, req.file.originalname);
      devisTexte = parsed.text || '';
      d._documents_recus = req.file.originalname;
    } catch (err) {
      console.error('Erreur parsing devis:', err.message);
    }
  }

  // Extraction regex (toujours actif, même sans IA)
  if (devisTexte) {
    const info = extractProjectInfo(devisTexte);
    if (!d.client_nom && info.client) d.client_nom = info.client;
    if (!d.projet_nom && info.client) d.projet_nom = info.client;
    if (!d.client_adresse && info.adresse) d.client_adresse = info.adresse;
    if (!d.client_ville && info.ville) d.client_ville = info.ville;
    if (!d.client_code_postal && info.code_postal) d.client_code_postal = info.code_postal;

    // Superficie en pieds carrés
    const supPcMatch = devisTexte.match(/(\d[\d\s,.]*)\s*(?:pi(?:eds?)?[\s²2]|sq\.?\s*f(?:t|eet)?|square\s*f(?:eet|t)?)/i);
    if (supPcMatch && !d.superficie_pc) d.superficie_pc = supPcMatch[1].replace(/[\s,]/g, '');

    // Superficie en m² → convertir en pi²
    const supM2Match = devisTexte.match(/(\d[\d\s,.]*)\s*m[²2]/i);
    if (supM2Match && !d.superficie_pc) {
      const valM2 = parseFloat(supM2Match[1].replace(/[\s,]/g, ''));
      if (!isNaN(valM2)) d.superficie_pc = Math.round(valM2 * 10.764).toString();
    }

    // Drains
    const drainMatch = devisTexte.match(/(\d+)\s*drain[s]?/i);
    if (drainMatch && !d.nb_drains) d.nb_drains = drainMatch[1];

    // Manchons d'évent
    const manchonEventMatch = devisTexte.match(/(\d+)\s*manchon[s]?\s*d['']?[ée]vent/i);
    if (manchonEventMatch && !d.nb_manchons_events) d.nb_manchons_events = manchonEventMatch[1];

    // Manchons d'étanchéité
    const manchonEtanchMatch = devisTexte.match(/(\d+)\s*manchon[s]?\s*(?:d['']?[ée]tanch[ée]it[ée]|de\s+tuyauterie)/i);
    if (manchonEtanchMatch && !d.nb_manchons_etancheite) d.nb_manchons_etancheite = manchonEtanchMatch[1];

    // Cols de cygne
    const colCygneMatch = devisTexte.match(/(\d+)\s*col[s]?[\s-]de[\s-]cygne|col[s]?[\s-]cygne/i);
    if (colCygneMatch && !d.nb_cols_cygne) d.nb_cols_cygne = colCygneMatch[1];

    // Téléphone
    const telMatch = devisTexte.match(/(?:t[ée]l(?:[ée]phone)?|phone|t\.)\s*[:#]?\s*(\d{3}[-.\s]\d{3}[-.\s]\d{4})/i)
      || devisTexte.match(/(\d{3}[-.\s]\d{3}[-.\s]\d{4})/);
    if (telMatch && !d.client_telephone) d.client_telephone = telMatch[1] || telMatch[0];

    // Courriel
    const emailMatch = devisTexte.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
    if (emailMatch && !d.client_courriel) d.client_courriel = emailMatch[0];

    // Système de toiture détecté dans le texte
    if (!d.systeme_toiture) {
      const systemeMap = [
        [/\bBUR\b|asphalte\s+(?:et\s+)?gravier|built[\s-]up/i, 'BUR'],
        [/\bSoprasmart\b/i, 'SOPRASMART'],
        [/\bSoprafix\b/i, 'SOPRAFIX'],
        [/\bColvent\b/i, 'COLVENT'],
        [/\bEPDM\b/i, 'EPDM_PVC'],
        [/\bTPO\b|Rhinobond/i, 'TPO_PVC_RHINOBOND'],
        [/toiture\s+invers[ée]e?|roof\s+invers/i, 'INVERSE'],
        [/ancestral|patrimonial/i, 'ANCESTRAL'],
      ];
      for (const [pat, val] of systemeMap) {
        if (pat.test(devisTexte)) { d.systeme_toiture = val; break; }
      }
    }

    // Épaisseur isolant
    const isolantMatch = devisTexte.match(/(\d+(?:[.,]\d+)?)\s*(?:po(?:uces?)?|inch(?:es)?|mm|cm)\s*(?:d['']isolant|isolant|insulation)/i);
    if (isolantMatch && !d.epaisseur_isolant) d.epaisseur_isolant = isolantMatch[1].replace(',', '.');

    // Type de pontage
    if (!d.pontage) {
      if (/pontage\s+(?:en\s+)?bois|wood\s+deck/i.test(devisTexte)) d.pontage = 'bois';
      else if (/pontage\s+(?:en\s+)?acier|metal\s+deck/i.test(devisTexte)) d.pontage = 'acier';
      else if (/pontage\s+(?:en\s+)?b[ée]ton|concrete\s+deck/i.test(devisTexte)) d.pontage = 'béton';
    }
  }

  // Analyse IA EXHAUSTIVE (GPT-4o, prompt détaillé comme les 12 étapes manuelles)
  if (isConfigured() && devisTexte) {
    try {
      const { analyserDevisSoumission } = require('../services/claude-client');
      // Envoyer un maximum de texte à l'IA (jusqu'à 30000 chars pour couvrir les sections techniques)
      const texteIA = devisTexte.substring(0, 30000);
      console.log(`[IA Soumission] Envoi de ${texteIA.length} chars au modèle GPT-4o...`);
      const iaResult = await analyserDevisSoumission(texteIA);
      console.log(`[IA Soumission] Résultat:`, JSON.stringify(iaResult).substring(0, 500));

      if (iaResult && !iaResult.error) {
        // L'IA REMPLACE tout — elle est plus fiable que le regex
        if (iaResult.client_nom) d.client_nom = iaResult.client_nom;
        if (iaResult.client_adresse) d.client_adresse = iaResult.client_adresse;
        if (iaResult.client_ville) d.client_ville = iaResult.client_ville;
        if (iaResult.client_province) d.client_province = iaResult.client_province;
        if (iaResult.client_code_postal) d.client_code_postal = iaResult.client_code_postal;
        if (iaResult.client_contact) d.client_contact = iaResult.client_contact;
        if (iaResult.client_telephone) d.client_telephone = iaResult.client_telephone;
        if (iaResult.client_courriel) d.client_courriel = iaResult.client_courriel;
        if (iaResult.projet_nom) d.projet_nom = iaResult.projet_nom;
        if (iaResult.projet_adresse) d.projet_adresse = iaResult.projet_adresse;
        if (iaResult.superficie_pc) d.superficie_pc = iaResult.superficie_pc;
        if (iaResult.pontage) d.pontage = iaResult.pontage;
        if (iaResult.epaisseur_isolant) d.epaisseur_isolant = iaResult.epaisseur_isolant;
        if (iaResult.pente_isolant) d.pente_isolant = iaResult.pente_isolant;
        if (iaResult.nb_drains) d.nb_drains = iaResult.nb_drains;
        if (iaResult.nb_manchons_events) d.nb_manchons_events = iaResult.nb_manchons_events;
        if (iaResult.nb_manchons_etancheite) d.nb_manchons_etancheite = iaResult.nb_manchons_etancheite;
        if (iaResult.nb_cols_cygne) d.nb_cols_cygne = iaResult.nb_cols_cygne;
        if (iaResult.systeme_toiture) d.systeme_toiture = iaResult.systeme_toiture;
        if (iaResult.type_travaux) d.type_travaux = iaResult.type_travaux;
        if (iaResult.garantie_t3e) d.garantie_t3e = iaResult.garantie_t3e;
        if (iaResult.garantie_manufacturier) d.garantie_manufacturier = iaResult.garantie_manufacturier;
        if (iaResult.cout_remplacement_cp) d.cout_remplacement_cp = iaResult.cout_remplacement_cp;
        if (iaResult.documents_recus) d.documents_recus = iaResult.documents_recus;
        if (iaResult.sections_devis) d.sections_devis = iaResult.sections_devis;
        if (iaResult.bassins) d.bassins = iaResult.bassins;
        // Champs techniques pour le générateur (résolution des slashs)
        if (iaResult.type_isolant) d.type_isolant = iaResult.type_isolant;
        if (iaResult.type_releves || iaResult.type_relevés) d.type_releves = iaResult.type_releves || iaResult.type_relevés;
        if (iaResult.methode_adhesion) d.methode_adhesion = iaResult.methode_adhesion;
        if (iaResult.type_gravier) d.type_gravier = iaResult.type_gravier;
        if (iaResult.nb_plis) d.nb_plis = iaResult.nb_plis;
        if (iaResult.epaisseur_fibre_bois) d.epaisseur_fibre_bois = iaResult.epaisseur_fibre_bois;
        if (iaResult.type_fibre) d.type_fibre = iaResult.type_fibre;
        if (iaResult.materiau_solins) d.materiau_solins = iaResult.materiau_solins;
        if (iaResult.cols_cygne_type) d.cols_cygne_type = iaResult.cols_cygne_type;
        if (iaResult.ventilateur_max) d.ventilateur_max = iaResult.ventilateur_max;
        if (iaResult.type_pare_vapeur) d.type_pare_vapeur = iaResult.type_pare_vapeur;
        if (iaResult.cout_remplacement_isolant) d.cout_remplacement_isolant = iaResult.cout_remplacement_isolant;
        if (iaResult.notes) d.notes = iaResult.notes;
      }
    } catch (err) {
      console.error('Erreur IA analyse soumission:', err.message);
    }
  }

  const clientNom = (d.client_nom && d.client_nom.trim()) || 'Client sans nom';
  const systeme = d.systeme_toiture || 'BUR';
  const typeTravaux = d.type_travaux || 'REFECTION';
  const numero = d.numero || await genererNumero(db);
  const templateKey = selectTemplate(systeme, typeTravaux);

  await db.execute(`
    INSERT INTO soumissions (
      numero, client_nom, client_adresse, client_ville, client_province, client_code_postal,
      client_contact, client_telephone, client_courriel,
      projet_nom, projet_adresse, systeme_toiture, type_travaux, langue, type_soumission,
      superficie_pc, pontage, epaisseur_isolant, pente_isolant,
      nb_drains, nb_manchons_events, nb_manchons_etancheite, nb_cols_cygne,
      ventilateur_max, cout_remplacement_cp, cout_remplacement_isolant,
      prix_total, garantie_t3e, garantie_manufacturier,
      exclusions_specifiques, documents_recus, notes, template_utilise, cree_par,
      type_isolant, type_releves, bassins, sections_devis,
      methode_adhesion, type_gravier, nb_plis, epaisseur_fibre_bois, type_fibre, materiau_solins, cols_cygne_type
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `, [
    numero, clientNom, v(d.client_adresse), v(d.client_ville), v(d.client_province) || 'QC', v(d.client_code_postal),
    v(d.client_contact), v(d.client_telephone), v(d.client_courriel),
    v(d.projet_nom), v(d.projet_adresse), systeme, typeTravaux, v(d.langue) || 'FR', v(d.type_soumission) || 'prive',
    v(d.superficie_pc), v(d.pontage), v(d.epaisseur_isolant), v(d.pente_isolant),
    v(d.nb_drains), v(d.nb_manchons_events), v(d.nb_manchons_etancheite), v(d.nb_cols_cygne),
    v(d.ventilateur_max), v(d.cout_remplacement_cp), v(d.cout_remplacement_isolant),
    v(d.prix_total), v(d.garantie_t3e) || '5 ans', v(d.garantie_manufacturier) || '10 ans',
    v(d.exclusions_specifiques), v(d.documents_recus || d._documents_recus), v(d.notes), v(templateKey), v(d.cree_par) || 'Estimateur',
    v(d.type_isolant), v(d.type_releves), v(d.bassins), v(d.sections_devis),
    v(d.methode_adhesion), v(d.type_gravier), v(d.nb_plis), v(d.epaisseur_fibre_bois), v(d.type_fibre), v(d.materiau_solins), v(d.cols_cygne_type)
  ]);

  const created = await db.execute('SELECT id FROM soumissions WHERE numero = ?', [numero]);
  res.redirect(`/soumissions/etape2/${created.rows[0].id}`);
});

// ÉTAPE 2 : Validation des données
router.get('/etape2/:id', async (req, res) => {
  const db = req.db;
  const result = await db.execute('SELECT * FROM soumissions WHERE id = ?', [req.params.id]);
  if (result.rows.length === 0) return res.redirect('/soumissions');

  const { isConfigured } = require('../services/claude-client');
  res.render('soumission-etape2', {
    soumission: result.rows[0],
    systemes: SYSTEMES,
    types_travaux: TYPES_TRAVAUX,
    pontages: PONTAGES,
    types_soumission: TYPES_SOUMISSION,
    garanties_t3e: GARANTIES_T3E,
    garanties_manuf: GARANTIES_MANUF,
    iaActive: isConfigured(),
  });
});

// ÉTAPE 2→3 : Confirmer, mettre à jour, et générer
router.post('/:id/confirmer', async (req, res) => {
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
      exclusions_specifiques=?, notes=?, template_utilise=?,
      type_isolant=?, type_releves=?, bassins=?, sections_devis=?,
      methode_adhesion=?, type_gravier=?, nb_plis=?, epaisseur_fibre_bois=?, type_fibre=?, materiau_solins=?, cols_cygne_type=?,
      updated_at=datetime('now')
    WHERE id=?
  `, [
    v(d.client_nom) || 'Client sans nom', v(d.client_adresse), v(d.client_ville), v(d.client_province) || 'QC', v(d.client_code_postal),
    v(d.client_contact), v(d.client_telephone), v(d.client_courriel),
    v(d.projet_nom), v(d.projet_adresse), v(d.systeme_toiture) || 'BUR', v(d.type_travaux) || 'REFECTION', v(d.langue) || 'FR', v(d.type_soumission) || 'prive',
    v(d.superficie_pc), v(d.pontage), v(d.epaisseur_isolant), v(d.pente_isolant),
    v(d.nb_drains), v(d.nb_manchons_events), v(d.nb_manchons_etancheite), v(d.nb_cols_cygne),
    v(d.ventilateur_max), v(d.cout_remplacement_cp), v(d.cout_remplacement_isolant),
    v(d.prix_total), v(d.garantie_t3e) || '5 ans', v(d.garantie_manufacturier) || '10 ans',
    v(d.exclusions_specifiques), v(d.notes), v(templateKey),
    v(d.type_isolant), v(d.type_releves), v(d.bassins), v(d.sections_devis),
    v(d.methode_adhesion), v(d.type_gravier), v(d.nb_plis), v(d.epaisseur_fibre_bois), v(d.type_fibre), v(d.materiau_solins), v(d.cols_cygne_type),
    req.params.id
  ]);

  // Générer automatiquement le document
  const result = await db.execute('SELECT * FROM soumissions WHERE id = ?', [req.params.id]);
  if (result.rows.length > 0) {
    try {
      const generated = await generateSoumission(result.rows[0]);
      await db.execute(
        "UPDATE soumissions SET fichier_genere=?, template_utilise=?, statut='genere', updated_at=datetime('now') WHERE id=?",
        [generated.filename, generated.templateUsed, req.params.id]
      );
    } catch (err) {
      console.error('Erreur génération:', err.message);
    }
  }

  res.redirect(`/soumissions/${req.params.id}`);
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
      type_isolant=?, type_releves=?, bassins=?, sections_devis=?,
      updated_at=datetime('now')
    WHERE id=?
  `, [
    v(d.client_nom) || 'Client sans nom', v(d.client_adresse), v(d.client_ville), v(d.client_province) || 'QC', v(d.client_code_postal),
    v(d.client_contact), v(d.client_telephone), v(d.client_courriel),
    v(d.projet_nom), v(d.projet_adresse), v(d.systeme_toiture) || 'BUR', v(d.type_travaux) || 'REFECTION', v(d.langue) || 'FR', v(d.type_soumission) || 'prive',
    v(d.superficie_pc), v(d.pontage), v(d.epaisseur_isolant), v(d.pente_isolant),
    v(d.nb_drains), v(d.nb_manchons_events), v(d.nb_manchons_etancheite), v(d.nb_cols_cygne),
    v(d.ventilateur_max), v(d.cout_remplacement_cp), v(d.cout_remplacement_isolant),
    v(d.prix_total), v(d.garantie_t3e) || '5 ans', v(d.garantie_manufacturier) || '10 ans',
    v(d.exclusions_specifiques), v(d.documents_recus), v(d.notes), v(templateKey),
    v(d.type_isolant), v(d.type_releves), v(d.bassins), v(d.sections_devis),
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
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Le fichier a été supprimé. Regénérez le document.');
  }
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

module.exports = router;
