// Orchestration de l'import direct depuis SEAO — appelé directement par les
// routes /appels-offres/importer-direct et /:id/actualiser-seao (Vercel,
// synchrone : voir seao-scraper.js pour la contrainte de 60 s par requête).
const crypto = require('crypto');
const { importerAvisSeao } = require('./seao-scraper');
const { uploadBuffer, sanitizeKey, BUCKETS } = require('./storage');
const { analyserExigences } = require('./seao-exigences');

async function enregistrerHistorique(db, appelOffreId, action, details) {
  try {
    await db.execute({
      sql: 'INSERT INTO historique_appels_offres (appel_offre_id, action, details, effectue_par) VALUES (?, ?, ?, ?)',
      args: [appelOffreId, action, details || null, 'Import automatique SEAO'],
    });
  } catch (e) {
    console.error('[seao-import] Historique non enregistré:', e.message);
  }
}

// Crée ou met à jour la fiche appel d'offres à partir des métadonnées
// extraites, puis dépose chaque document récupéré dans Supabase Storage et
// l'enregistre dans appels_offres_documents (même bucket/convention de clé
// que l'import manuel — voir appels-offres.js:POST /:id/documents).
async function importerEtEnregistrer(db, { appelOffreId, url, numeroAvis }) {
  const resultat = await importerAvisSeao({ url, numeroAvis });

  if (!resultat.ok) {
    if (appelOffreId) {
      await db.execute({
        sql: `UPDATE appels_offres_seao SET statut_import = 'erreur', erreur_import = ?, derniere_synchronisation_documents = datetime('now') WHERE id = ?`,
        args: [resultat.error, appelOffreId],
      });
      await enregistrerHistorique(db, appelOffreId, 'import_seao_echoue', resultat.error);
    }
    return { ok: false, error: resultat.error };
  }

  const { metadonnees, documents } = resultat;
  let id = appelOffreId;

  if (id) {
    await db.execute({
      sql: `UPDATE appels_offres_seao SET
        titre = COALESCE(?, titre), donneur_ouvrage = COALESCE(?, donneur_ouvrage),
        lieu_travaux = COALESCE(?, lieu_travaux), date_publication = COALESCE(?, date_publication),
        date_fermeture = COALESCE(?, date_fermeture), date_visite_obligatoire = COALESCE(?, date_visite_obligatoire),
        url_seao = COALESCE(?, url_seao), statut_import = 'succes', erreur_import = NULL,
        derniere_synchronisation_documents = datetime('now'), updated_at = datetime('now')
        WHERE id = ?`,
      args: [
        metadonnees.titre || null, metadonnees.donneur_ouvrage || null, metadonnees.lieu_travaux || null,
        metadonnees.date_publication || null, metadonnees.date_fermeture || null, metadonnees.date_visite_obligatoire || null,
        metadonnees.url_seao || null, id,
      ],
    });
  } else {
    const numero = metadonnees.numero_seao || numeroAvis || ('SEAO-' + Date.now());
    const inser = await db.execute({
      sql: `INSERT INTO appels_offres_seao
        (numero_seao, titre, donneur_ouvrage, lieu_travaux, date_publication, date_fermeture,
         date_visite_obligatoire, url_seao, statut_import, derniere_synchronisation_documents)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'succes', datetime('now'))
        ON CONFLICT(numero_seao) DO UPDATE SET
          titre = excluded.titre, donneur_ouvrage = excluded.donneur_ouvrage, url_seao = excluded.url_seao,
          statut_import = 'succes', derniere_synchronisation_documents = datetime('now'), updated_at = datetime('now')`,
      args: [
        numero, metadonnees.titre || numero, metadonnees.donneur_ouvrage || null, metadonnees.lieu_travaux || null,
        metadonnees.date_publication || null, metadonnees.date_fermeture || null,
        metadonnees.date_visite_obligatoire || null, metadonnees.url_seao || url || null,
      ],
    });
    id = inser.lastInsertRowid ? Number(inser.lastInsertRowid) : (await db.execute({ sql: 'SELECT id FROM appels_offres_seao WHERE numero_seao = ?', args: [numero] })).rows[0].id;
  }

  let documentsImportes = 0;
  for (const doc of documents) {
    try {
      const cle = sanitizeKey(`${id}/${doc.categorie}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${doc.nom_fichier}`);
      await uploadBuffer(BUCKETS.SEAO, cle, doc.buffer);
      await db.execute({
        sql: 'INSERT INTO appels_offres_documents (appel_offre_id, categorie, cle_storage, nom_fichier) VALUES (?, ?, ?, ?)',
        args: [id, doc.categorie, cle, doc.nom_fichier],
      });
      if (doc.categorie === 'formulaire_soumission') {
        const ext = (doc.nom_fichier.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
        await db.execute({
          sql: `INSERT INTO appels_offres_formulaires (appel_offre_id, cle_storage_original, format, statut) VALUES (?, ?, ?, 'a_remplir')`,
          args: [id, cle, ext],
        });
      }
      documentsImportes++;
    } catch (e) {
      console.error('[seao-import] Document non enregistré:', doc.nom_fichier, e.message);
    }
  }

  await enregistrerHistorique(db, id, 'import_seao_reussi', `${documentsImportes}/${documents.length} document(s) importé(s) automatiquement depuis SEAO.`);

  // Lance directement l'extraction des exigences — même service, même
  // machine, pas de raison d'attendre un second déclenchement manuel.
  try {
    const analyse = await analyserExigences(db, id);
    if (analyse.error) await enregistrerHistorique(db, id, 'exigences_analyse_echouee', analyse.error);
    else await enregistrerHistorique(db, id, 'exigences_analysees', `${analyse.inserees} exigence(s) extraite(s) après import SEAO.`);
  } catch (e) {
    console.error('[seao-import] Analyse des exigences échouée:', e.message);
  }

  return { ok: true, appelOffreId: id, documentsImportes };
}

module.exports = { importerEtEnregistrer };
