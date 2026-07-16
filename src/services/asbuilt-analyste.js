// Moteur d'analyse du module « tel que construit ».
// Deux passes :
//   1. Extraction PAR DOCUMENT : feuilles, zones, équipements, mentions
//      (« non installé », « déplacé »…) — chaque élément cite sa page et un
//      extrait verbatim (traçabilité obligatoire).
//   2. Synthèse PAR PROJET : à partir des extractions des documents de
//      changement (avenants, directives, OC, rapports, DDI, relevés, plans
//      annotés), propose des modifications pour le registre.
// Règles dures (répétées dans les prompts ET appliquées en code) :
//   - ne JAMAIS inventer : toute modification sans extrait source est rejetée;
//   - une directive émise n'est PAS une preuve d'exécution : sans preuve dans
//     un rapport/photo/plan annoté, la modification est marquée « à vérifier »;
//   - confiance < 0.6 ou information contradictoire → « à vérifier »;
//   - aucun plan n'est final sans validation humaine (le moteur ne touche
//     jamais aux statuts approuvée/intégrée).
// Ne lève jamais : { ok, erreur? } et consigne l'état dans la DB, car il
// tourne en arrière-plan (même patron que genererEtSauvegarderManuel).
const { analyserJSON } = require('./ia-provider');
const { downloadBuffer, BUCKETS } = require('./storage');
const { parsePdfBuffer, texteParPage } = require('./document-parser');

const MAX_CHARS_DOCUMENT = 60000;   // budget de contexte par document
const MAX_CHARS_SYNTHESE = 120000;  // budget de contexte pour la synthèse

const EXTENSIONS_TEXTE = ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'txt', 'csv'];

// ── Extraction du texte d'un document (avec numéros de page pour les PDF) ──
async function extraireTexte(doc, buffer) {
  const ext = (doc.type_fichier || '').toLowerCase();
  if (ext === 'pdf') {
    const pages = await texteParPage(buffer);
    // Marqueurs de page pour que l'IA puisse citer la page exacte.
    const texte = pages.map((t, i) => `=== PAGE ${i + 1} ===\n${t}`).join('\n');
    return { texte, nbPages: pages.length };
  }
  if (ext === 'txt' || ext === 'csv') {
    return { texte: buffer.toString('utf8'), nbPages: 1 };
  }
  if (ext === 'docx') {
    const mammoth = require('mammoth');
    const r = await mammoth.extractRawText({ buffer });
    return { texte: r.value || '', nbPages: 1 };
  }
  if (ext === 'xlsx' || ext === 'xls') {
    const XLSX = require('xlsx');
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const morceaux = [];
    for (const nom of wb.SheetNames) {
      morceaux.push(`=== FEUILLE ${nom} ===\n` + XLSX.utils.sheet_to_csv(wb.Sheets[nom]));
    }
    return { texte: morceaux.join('\n'), nbPages: wb.SheetNames.length };
  }
  return { texte: '', nbPages: 0 }; // images, DWG/DXF/IFC/RVT : pas de texte extractible dans le MVP
}

// ── Schéma d'extraction par document (strict OpenAI : tout en required) ─────
const SCHEMA_EXTRACTION = {
  type: 'object',
  additionalProperties: false,
  required: ['feuilles', 'zones', 'niveaux', 'disciplines', 'equipements', 'mentions', 'approbations', 'resume'],
  properties: {
    feuilles: { type: 'array', items: { type: 'string' }, description: 'Numéros de feuilles/détails cités (ex. A-101, M-3, détail 5/A-500)' },
    zones: { type: 'array', items: { type: 'string' }, description: 'Zones, bassins, secteurs, axes cités' },
    niveaux: { type: 'array', items: { type: 'string' } },
    disciplines: { type: 'array', items: { type: 'string' } },
    equipements: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['nom', 'dimension', 'quantite', 'materiau', 'page', 'extrait'],
        properties: {
          nom: { type: 'string' },
          dimension: { type: ['string', 'null'] },
          quantite: { type: ['string', 'null'] },
          materiau: { type: ['string', 'null'] },
          page: { type: ['integer', 'null'] },
          extrait: { type: 'string', description: 'Citation VERBATIM du document' },
        },
      },
    },
    mentions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['type', 'element', 'feuille', 'zone', 'page', 'extrait', 'date', 'approuve_par'],
        properties: {
          type: { type: 'string', enum: ['non_installe', 'retire', 'deplace', 'ajoute', 'remplace', 'modifie', 'tel_que_construit', 'contradiction', 'autre'] },
          element: { type: 'string' },
          feuille: { type: ['string', 'null'] },
          zone: { type: ['string', 'null'] },
          page: { type: ['integer', 'null'] },
          extrait: { type: 'string', description: 'Citation VERBATIM justifiant la mention' },
          date: { type: ['string', 'null'] },
          approuve_par: { type: ['string', 'null'] },
        },
      },
    },
    approbations: { type: 'array', items: { type: 'string' } },
    resume: { type: 'string' },
  },
};

async function analyserDocument(db, doc) {
  await db.execute({ sql: `UPDATE asbuilt_documents SET statut_analyse = 'en_cours' WHERE id = ?`, args: [doc.id] });

  const buffer = await downloadBuffer(BUCKETS.PLANS_ASBUILT, doc.cle_stockage);
  if (!buffer) {
    await db.execute({ sql: `UPDATE asbuilt_documents SET statut_analyse = 'erreur', erreur_analyse = 'Fichier introuvable dans le stockage' WHERE id = ?`, args: [doc.id] });
    return;
  }

  let texte = '', nbPages = 0;
  if (EXTENSIONS_TEXTE.includes((doc.type_fichier || '').toLowerCase())) {
    try {
      const r = await extraireTexte(doc, buffer);
      texte = r.texte; nbPages = r.nbPages;
    } catch (e) {
      await db.execute({ sql: `UPDATE asbuilt_documents SET statut_analyse = 'erreur', erreur_analyse = ? WHERE id = ?`, args: ['Extraction texte: ' + e.message, doc.id] });
      return;
    }
  }

  if (!texte || texte.trim().length < 30) {
    // Photos, scans sans OCR, formats CAO : pas de texte — signalé, jamais inventé.
    await db.execute({ sql: `UPDATE asbuilt_documents SET statut_analyse = 'sans_texte', nb_pages = ? WHERE id = ?`, args: [nbPages || null, doc.id] });
    return;
  }

  const system = `Tu analyses un document de chantier pour la production de plans « tel que construit ».
RÈGLES ABSOLUES :
- N'invente RIEN. Chaque équipement et chaque mention DOIT citer un extrait VERBATIM du texte fourni (champ "extrait") et sa page (les pages sont marquées "=== PAGE N ===").
- Si une information n'est pas dans le texte, mets null ou une liste vide.
- Les mentions à repérer : élément non installé, retiré, déplacé, ajouté, remplacé, modifié, « tel que construit », ou toute contradiction entre exigences.
- Une directive ÉMISE n'est pas une preuve d'exécution — rapporte-la telle quelle, sans conclure.`;

  const user = `Document : « ${doc.nom} » — catégorie : ${doc.categorie}${doc.version ? ' — version ' + doc.version : ''}${doc.date_document ? ' — daté du ' + doc.date_document : ''}.
Texte (tronqué à ${MAX_CHARS_DOCUMENT} caractères) :
${texte.substring(0, MAX_CHARS_DOCUMENT)}`;

  const r = await analyserJSON({ system, user, schema: SCHEMA_EXTRACTION, maxTokens: 8000 });
  if (!r.ok) {
    await db.execute({ sql: `UPDATE asbuilt_documents SET statut_analyse = 'erreur', erreur_analyse = ? WHERE id = ?`, args: [r.erreur.substring(0, 500), doc.id] });
    return;
  }

  await db.execute({
    sql: `UPDATE asbuilt_documents SET statut_analyse = 'analyse', nb_pages = ?, extraction = ?, erreur_analyse = NULL WHERE id = ?`,
    args: [nbPages || null, JSON.stringify(r.data), doc.id],
  });
}

// ── Synthèse : proposer les modifications du registre ────────────────────────
const SCHEMA_MODIFICATIONS = {
  type: 'object',
  additionalProperties: false,
  required: ['modifications'],
  properties: {
    modifications: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['titre', 'description', 'type', 'discipline', 'feuille', 'zone', 'element',
          'action_proposee', 'document_id', 'page_source', 'extrait_source', 'confiance',
          'priorite', 'preuve_execution', 'references_connexes'],
        properties: {
          titre: { type: 'string' },
          description: { type: 'string' },
          type: { type: 'string', enum: ['ajout', 'suppression', 'deplacement', 'dimension', 'materiau', 'quantite', 'equipement', 'detail', 'contradiction', 'info_manquante'] },
          discipline: { type: ['string', 'null'] },
          feuille: { type: ['string', 'null'] },
          zone: { type: ['string', 'null'] },
          element: { type: ['string', 'null'] },
          action_proposee: { type: 'string', description: 'Action concrète sur le plan tel que construit (ex. retirer le drain D-3 de la feuille M-101)' },
          document_id: { type: 'integer', description: 'id du document source (fourni dans le contexte)' },
          page_source: { type: ['integer', 'null'] },
          extrait_source: { type: 'string', description: 'Citation VERBATIM du document source' },
          confiance: { type: 'number', description: '0 à 1' },
          priorite: { type: 'string', enum: ['basse', 'normale', 'haute', 'critique'] },
          preuve_execution: {
            type: 'object', additionalProperties: false,
            required: ['statut', 'description'],
            properties: {
              statut: { type: 'string', enum: ['preuve_trouvee', 'aucune_preuve', 'preuve_partielle'] },
              description: { type: 'string' },
            },
          },
          references_connexes: {
            type: 'array', items: { type: 'string' },
            description: 'Feuilles/disciplines/tableaux susceptibles d\'être aussi touchés (à vérifier par le réviseur)',
          },
        },
      },
    },
  },
};

async function synthetiserModifications(db, projetId) {
  const docs = (await db.execute({
    sql: `SELECT id, nom, categorie, version, date_document, extraction FROM asbuilt_documents WHERE projet_id = ? AND statut_analyse = 'analyse'`,
    args: [projetId],
  })).rows;

  const docsChangement = docs.filter((d) => !['plan_initial', 'photo'].includes(d.categorie));
  if (docsChangement.length === 0) return { inserees: 0 };

  const plans = docs.filter((d) => d.categorie === 'plan_initial');
  let contexte = 'PLANS INITIAUX DU PROJET (référence) :\n';
  for (const p of plans) {
    let ex; try { ex = JSON.parse(p.extraction); } catch (_) { ex = null; }
    contexte += `- [document_id=${p.id}] ${p.nom} — feuilles : ${ex && ex.feuilles ? ex.feuilles.join(', ') : 'inconnues'}\n`;
  }
  contexte += '\nDOCUMENTS DE CHANGEMENT (extractions déjà sourcées) :\n';
  for (const d of docsChangement) {
    contexte += `\n--- [document_id=${d.id}] ${d.nom} (${d.categorie}${d.version ? ', v' + d.version : ''}${d.date_document ? ', ' + d.date_document : ''}) ---\n`;
    contexte += (d.extraction || '{}') + '\n';
    if (contexte.length > MAX_CHARS_SYNTHESE) break;
  }

  const system = `Tu prépares le REGISTRE DES MODIFICATIONS d'un plan « tel que construit ».
À partir des extractions fournies (déjà liées à leurs documents), liste chaque changement entre le projet initial et les travaux réellement exécutés.
RÈGLES ABSOLUES :
- N'invente RIEN : chaque modification DOIT reprendre un extrait VERBATIM déjà présent dans les extractions et référencer son document_id et sa page.
- Une directive/un avenant ÉMIS n'est pas une preuve d'exécution : cherche la preuve dans les rapports journaliers, relevés ou plans annotés fournis. Sans preuve → preuve_execution.statut = "aucune_preuve".
- En cas d'informations contradictoires entre documents → type "contradiction".
- Information incomplète → type "info_manquante", confiance basse.
- confiance : 0 à 1, honnête (0.9+ seulement si la source est explicite et non ambiguë).
- Ne conclus JAMAIS qu'un plan est final : tu proposes, un humain valide.`;

  const r = await analyserJSON({
    system,
    user: contexte.substring(0, MAX_CHARS_SYNTHESE),
    schema: SCHEMA_MODIFICATIONS,
    maxTokens: 12000,
  });
  if (!r.ok) throw new Error('Synthèse IA : ' + r.erreur);

  const idsValides = new Set(docs.map((d) => d.id));
  let inserees = 0;
  for (const m of (r.data.modifications || [])) {
    // Garde-fous côté code (les règles du prompt ne suffisent jamais seules) :
    // pas de source vérifiable → rejet pur et simple.
    if (!m.extrait_source || !m.titre) continue;
    if (!idsValides.has(m.document_id)) continue;
    const confiance = Math.max(0, Math.min(1, Number(m.confiance) || 0));
    const sansPreuve = !m.preuve_execution || m.preuve_execution.statut !== 'preuve_trouvee';
    const statut = (confiance < 0.6 || sansPreuve || m.type === 'contradiction' || m.type === 'info_manquante')
      ? 'a_verifier' : 'detectee';

    await db.execute({
      sql: `INSERT INTO asbuilt_modifications
            (projet_id, titre, description, type, discipline, feuille, zone, element, action_proposee,
             document_id, page_source, extrait_source, confiance, priorite, statut, preuve_execution, references_connexes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        projetId, m.titre.substring(0, 300), m.description || '', m.type || null,
        m.discipline || null, m.feuille || null, m.zone || null, m.element || null,
        m.action_proposee || '', m.document_id, m.page_source || null,
        m.extrait_source.substring(0, 2000), confiance,
        ['basse', 'normale', 'haute', 'critique'].includes(m.priorite) ? m.priorite : 'normale',
        statut,
        JSON.stringify(m.preuve_execution || { statut: 'aucune_preuve', description: '' }),
        JSON.stringify(m.references_connexes || []),
      ],
    });
    inserees++;
  }
  return { inserees };
}

// ── Point d'entrée : analyse complète d'un projet ────────────────────────────
async function analyserProjetAsbuilt(db, projetId) {
  try {
    const docs = (await db.execute({
      sql: `SELECT * FROM asbuilt_documents WHERE projet_id = ? AND statut_analyse IN ('en_attente', 'erreur')`,
      args: [projetId],
    })).rows;

    for (const doc of docs) {
      try {
        await analyserDocument(db, doc);
      } catch (e) {
        console.error('[asbuilt-analyste] document', doc.id, ':', e.message);
        await db.execute({ sql: `UPDATE asbuilt_documents SET statut_analyse = 'erreur', erreur_analyse = ? WHERE id = ?`, args: [e.message.substring(0, 500), doc.id] }).catch(() => {});
      }
    }

    // On repart d'un registre propre pour les modifications NON traitées :
    // les décisions humaines (approuvée/refusée/annotée/intégrée/à clarifier
    // commentée) sont conservées, seules les lignes vierges sont regénérées.
    await db.execute({
      sql: `DELETE FROM asbuilt_modifications WHERE projet_id = ? AND statut IN ('detectee', 'a_verifier') AND (commentaire_reviseur IS NULL OR commentaire_reviseur = '')`,
      args: [projetId],
    });

    const { inserees } = await synthetiserModifications(db, projetId);

    await db.execute({
      sql: `UPDATE asbuilt_projets SET statut = 'revision', updated_at = datetime('now') WHERE id = ?`,
      args: [projetId],
    });
    console.log(`[asbuilt-analyste] projet ${projetId} : ${inserees} modification(s) proposée(s)`);
    return { ok: true, inserees };
  } catch (e) {
    console.error('[asbuilt-analyste] projet', projetId, ':', e.message);
    await db.execute({
      sql: `UPDATE asbuilt_projets SET statut = 'documents', notes = COALESCE(notes,'') || char(10) || ? , updated_at = datetime('now') WHERE id = ?`,
      args: ['[Analyse échouée ' + new Date().toISOString() + '] ' + e.message.substring(0, 300), projetId],
    }).catch(() => {});
    return { ok: false, erreur: e.message };
  }
}

module.exports = { analyserProjetAsbuilt, analyserDocument, synthetiserModifications };
