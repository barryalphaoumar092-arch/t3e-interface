// Pré-remplissage des formulaires SEAO à partir de la base de connaissances.
// Le résultat de l'extraction IA est mis en cache (table `configuration`) car
// les informations d'entreprise T3E changent rarement — pas besoin de
// ré-analyser des certificats à chaque formulaire ouvert.
const { downloadBuffer, BUCKETS } = require('./storage');
const { parsePdfBuffer } = require('./document-parser');
const { analyserInfosEntreprise } = require('./claude-client');

// v3 : schema d'extraction encore elargi (TPS/TVH, TVQ, courriel corporatif,
// coordonnees directes du representant) + correction du bug de resolution de
// bucket qui faisait echouer silencieusement la lecture de certains
// documents "Certificats corporatifs" — le suffixe invalide automatiquement
// tout cache calcule avec l'ancien schema/bug.
const CLE_CACHE = 'seao_infos_entreprise_v3';
const CACHE_MAX_AGE_JOURS = 30;

// Documents les plus denses en information pour le pré-remplissage — évite de
// parser les 174 documents de la base de connaissances (dont ~90 sont des
// certificats d'assurance par client, non pertinents ici) pour un seul appel
// IA. Filtre sur le TITRE (voir project_manuel... même logique que les autres
// modules : les titres viennent directement des noms de fichiers réels).
const TITRES_PERTINENTS = [
  'RBQ', 'Licence RBQ', 'Registre des entreprises', 'Registre des détenteurs de licence',
  "Certificat d'incorporation", 'Toitures Trois Étoiles Inc',
  'ISO', 'AMCQ', 'APECQ', 'ARQ', 'Conformite CNESST', 'NRCA', 'CRCA', 'Safe Contractor',
  'Trois Étoiles - 10M', 'Trois Étoiles - 15M', 'Trois Étoiles - 5M',
  'Résolution de compagnie', 'AUTOMOBILE INSURANCE',
  // AMP et francisation — auparavant absents du filtre (bug corrigé) : sans
  // eux, l'IA ne pouvait jamais renseigner AMP_NUMERO_CLIENT/ECHEANCE ni
  // FRANCISATION_STATUT, meme si les documents etaient deja dans la base.
  'AMP', 'francisation',
];

async function chargerDocumentsPertinents(db) {
  const r = await db.execute(`
    SELECT d.id, d.titre, d.nom_fichier, d.chemin_fichier, c.nom as categorie
    FROM documents d JOIN categories c ON d.categorie_id = c.id
    WHERE c.nom IN ('Certificats corporatifs', 'Assurances', 'Département Service')
      AND d.statut = 'actif'
  `);
  const pertinents = r.rows.filter((doc) =>
    TITRES_PERTINENTS.some((t) => doc.titre.toLowerCase().includes(t.toLowerCase()))
  );
  // Toujours inclure au moins les certificats corporatifs meme si le filtre
  // par titre est trop strict (garde-fou pour ne jamais partir d'un contexte vide).
  if (pertinents.length === 0) {
    return r.rows.filter((d) => d.categorie === 'Certificats corporatifs').slice(0, 20);
  }
  return pertinents.slice(0, 35); // plafond raisonnable pour le budget de tokens OpenAI
}

async function construireContexteTexte(documents) {
  const morceaux = [];
  let budget = 60000;
  for (const doc of documents) {
    if (budget <= 0) break;
    // Meme piege que connaissances.js/seao-annexes.js : deviner une cle a
    // plat dans le bucket "documents" plutot que resoudre le vrai
    // bucket/chemin faisait echouer silencieusement la lecture d'un
    // document pourtant present dans la base de connaissances — l'IA se
    // retrouvait alors sans le contenu du document pour en extraire les
    // champs, meme si "Certificats corporatifs" contenait bien l'info.
    const { resoudreBucketEtCle } = require('./storage');
    const { bucket, key } = resoudreBucketEtCle(doc.chemin_fichier, doc.nom_fichier);
    const buf = await downloadBuffer(bucket, key);
    if (!buf) continue;
    try {
      const { text } = await parsePdfBuffer(buf);
      if (!text || !text.trim()) continue;
      const extrait = text.substring(0, Math.min(3000, budget));
      morceaux.push(`=== ${doc.titre} (${doc.categorie}) ===\n${extrait}`);
      budget -= extrait.length;
    } catch (e) {
      console.error('[seao-autofill] Lecture document échouée:', doc.titre, e.message);
    }
  }
  return morceaux.join('\n\n---\n\n');
}

async function obtenirInfosEntreprise(db, { forcerRecalcul = false } = {}) {
  if (!forcerRecalcul) {
    const r = await db.execute({ sql: 'SELECT valeur, updated_at FROM configuration WHERE cle = ?', args: [CLE_CACHE] });
    if (r.rows.length > 0) {
      const ageJours = (Date.now() - new Date(r.rows[0].updated_at + 'Z').getTime()) / (1000 * 60 * 60 * 24);
      if (ageJours < CACHE_MAX_AGE_JOURS) {
        try { return JSON.parse(r.rows[0].valeur); } catch (_) {}
      }
    }
  }

  const documents = await chargerDocumentsPertinents(db);
  const contexte = await construireContexteTexte(documents);
  if (!contexte.trim()) {
    return { error: 'Aucun document de la base de connaissances n\'a pu être lu pour le pré-remplissage.' };
  }

  const infos = await analyserInfosEntreprise(contexte);
  if (infos.error) return infos;

  await db.execute({
    sql: `INSERT INTO configuration (cle, valeur, updated_at) VALUES (?, ?, datetime('now'))
          ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur, updated_at = datetime('now')`,
    args: [CLE_CACHE, JSON.stringify(infos)],
  });

  return infos;
}

module.exports = { obtenirInfosEntreprise };
