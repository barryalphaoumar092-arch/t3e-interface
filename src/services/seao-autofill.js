// Pré-remplissage des formulaires SEAO à partir de la base de connaissances.
// Le résultat de l'extraction IA est mis en cache (table `configuration`) car
// les informations d'entreprise T3E changent rarement — pas besoin de
// ré-analyser des certificats à chaque formulaire ouvert.
const { downloadBuffer, BUCKETS } = require('./storage');
const { parsePdfBuffer } = require('./document-parser');
const { analyserInfosEntreprise } = require('./claude-client');
const { champsEntrepriseFixes } = require('./infos-entreprise-t3e');

// v4 : les coordonnees/identifiants officiels de T3E (NEQ, RBQ, CCQ, CNESST,
// TPS/TVQ, NEA, adresse, site, courriel, telecopieur, signataire) sont
// desormais des constantes FIXES (voir infos-entreprise-t3e.js) qui ECRASENT
// systematiquement le resultat de l'IA, plutot que d'etre re-devinees a
// chaque fois a partir des documents (fragile — a deja produit des valeurs
// fausses ou vides). Le suffixe invalide tout cache calcule avant ce
// changement (qui ne contenait pas ces champs garantis corrects).
// v5 : correction du filtre de selection des certificats (categories/titres
// desormais compares sans egard aux accents/majuscules, plafonds de
// documents/caracteres releves — voir chargerDocumentsPertinents). Le
// suffixe invalide tout cache v4 qui avait pu se calculer avec des
// certificats manquants silencieusement.
const CLE_CACHE = 'seao_infos_entreprise_v5';
const CACHE_MAX_AGE_JOURS = 30;

// Garde-fou : un champ REPRESENTANT_TELEPHONE/CELLULAIRE sans aucun chiffre
// n'est pas un numero de telephone (bug deja observe : l'IA y avait mis le
// nom du signataire autorise, confondu avec le representant, en l'absence de
// profil selectionne — voir representants.js/champsRepresentant() qui
// ecrase normalement ce champ UNE FOIS un representant choisi par l'utilisateur).
function nettoyerChampsRepresentant(infos) {
  const resultat = { ...infos };
  for (const cle of ['REPRESENTANT_TELEPHONE', 'REPRESENTANT_CELLULAIRE']) {
    if (resultat[cle] && !/\d/.test(resultat[cle])) resultat[cle] = '';
  }
  return resultat;
}

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
  // Fiche d'identité T3E — document créé pour combler des faits absents de
  // tout autre document de la base (site internet, courriel corporatif,
  // TPS/TVH, TVQ) : ces valeurs n'étaient jamais extraites automatiquement
  // faute de source texte, même si l'utilisateur les avait fournies.
  // Le document est enregistre sans accent ("identite" -- voir titre reel
  // dans la base) : le filtre par sous-chaine est sensible aux accents, un
  // "identité" ici ne matchait donc jamais et le document n'etait jamais
  // inclus dans le contexte envoye a l'IA malgre sa presence dans la base.
  "Fiche d'identite",
];

// Comparaison de texte insensible aux accents ET aux majuscules — un titre ou
// nom de categorie saisi sans accent ("identite", "departement") doit matcher
// la meme chose accentuee ("identité", "département") et vice-versa. Bug deja
// observe une fois avec "Fiche d'identité"/"identite" (voir commentaire plus
// bas) : plutot que de corriger au cas par cas a chaque nouvel accent
// divergent, on normalise une fois pour toutes les comparaisons de ce fichier.
function normaliser(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

const CATEGORIES_CERTIFICATS = ['Certificats corporatifs', 'Assurances', 'Département Service'];

async function chargerDocumentsPertinents(db) {
  // On ne filtre plus par c.nom IN (...) au niveau SQL (comparaison exacte,
  // sensible aux accents/majuscules — un document classe sous une variante
  // orthographique de ces categories devenait invisible sans aucune erreur).
  // On recupere tout et on compare normalise en JS.
  const r = await db.execute(`
    SELECT d.id, d.titre, d.nom_fichier, d.chemin_fichier, c.nom as categorie
    FROM documents d JOIN categories c ON d.categorie_id = c.id
    WHERE d.statut = 'actif'
  `);
  const categoriesNorm = CATEGORIES_CERTIFICATS.map(normaliser);
  const dansCategorieCertificat = r.rows.filter((doc) =>
    categoriesNorm.includes(normaliser(doc.categorie))
  );

  const pertinents = dansCategorieCertificat.filter((doc) =>
    TITRES_PERTINENTS.some((t) => normaliser(doc.titre).includes(normaliser(t)))
  );
  // La Fiche d'identite est toujours placee en tete : avec ~121 certificats
  // dans ces categories (dont beaucoup matchent deja les mots-cles larges
  // ci-dessus), le plafond plus bas coupait silencieusement ce document
  // precis des lors qu'il n'etait pas parmi les premiers retournes par la
  // requete (sans ORDER BY, donc par ordre d'insertion — un document ajoute
  // apres coup se retrouve toujours en dernier).
  pertinents.sort((a, b) => {
    const aFiche = normaliser(a.titre).includes("fiche d'identite") ? 0 : 1;
    const bFiche = normaliser(b.titre).includes("fiche d'identite") ? 0 : 1;
    return aFiche - bFiche;
  });
  // Toujours inclure au moins les certificats corporatifs meme si le filtre
  // par titre est trop strict (garde-fou pour ne jamais partir d'un contexte vide).
  let retenus = pertinents;
  if (retenus.length === 0) {
    retenus = dansCategorieCertificat.filter((d) => normaliser(d.categorie) === normaliser('Certificats corporatifs')).slice(0, 20);
  }
  // Plafond relevé (35 → 60) : avec ~121 certificats potentiels et des
  // mots-clés larges (RBQ, ISO...), 35 pouvait encore couper des documents
  // pertinents ajoutés après coup. On logge explicitement ce qui est exclu
  // plutôt que de le couper silencieusement (voir aussi le budget de
  // caractères dans construireContexteTexte, qui peut couper plus tôt encore).
  const LIMITE_DOCUMENTS = 60;
  if (retenus.length > LIMITE_DOCUMENTS) {
    const exclus = retenus.slice(LIMITE_DOCUMENTS).map((d) => d.titre);
    console.warn(`[seao-autofill] ${exclus.length} document(s) pertinent(s) exclus par le plafond de ${LIMITE_DOCUMENTS} :`, exclus);
  }
  return retenus.slice(0, LIMITE_DOCUMENTS);
}

async function construireContexteTexte(documents) {
  const morceaux = [];
  // Relevé (60000 → 150000) : avec jusqu'à 60 documents de 3000 caractères
  // chacun (voir LIMITE_DOCUMENTS), l'ancien budget de 60000 pouvait couper
  // silencieusement les documents en fin de liste, y compris des certificats
  // pertinents. gpt-4o supporte largement ce volume de contexte.
  let budget = 150000;
  for (const doc of documents) {
    if (budget <= 0) {
      console.warn(`[seao-autofill] Budget de contexte épuisé, ${documents.length - morceaux.length} document(s) restant(s) non lus.`);
      break;
    }
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
        try {
          const cache = JSON.parse(r.rows[0].valeur);
          return nettoyerChampsRepresentant({ ...cache, ...champsEntrepriseFixes() });
        } catch (_) {}
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

  return nettoyerChampsRepresentant({ ...infos, ...champsEntrepriseFixes() });
}

module.exports = { obtenirInfosEntreprise };
