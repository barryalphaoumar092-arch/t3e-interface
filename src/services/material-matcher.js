const STOP_WORDS = new Set([
  'le', 'la', 'les', 'de', 'du', 'des', 'et', 'pour', 'avec', 'dans',
  'sur', 'par', 'une', 'un', 'en', 'au', 'aux', 'ce', 'cette', 'ces',
  'qui', 'que', 'est', 'sont', 'être', 'avoir', 'pas', 'plus', 'ou',
  'the', 'and', 'for', 'with', 'from', 'type', 'mm', 'po', 'pi',
]);

function normalize(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(str) {
  return normalize(str)
    .split(' ')
    .filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

function jaccard(tokensA, tokensB) {
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let inter = 0;
  for (const t of setA) {
    if (setB.has(t)) inter++;
  }
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : inter / union;
}

async function matchMaterials(devisText, db) {
  const allMats = await db.execute(
    'SELECT id, nom, fabricant, type_produit, type_systeme, fournisseur, dimension, unite, lien_fiche_technique, lien_fiche_securite FROM materiaux'
  );

  const normalizedDevis = normalize(devisText);
  const devisTokens = tokenize(devisText);

  const fabricants = [...new Set(allMats.rows.map(m => m.fabricant).filter(Boolean))];
  const foundFabricants = fabricants.filter(f => normalizedDevis.includes(normalize(f)));

  const typesProduit = [...new Set(allMats.rows.map(m => m.type_produit).filter(Boolean))];
  const foundTypes = typesProduit.filter(t => normalizedDevis.includes(normalize(t)));

  const scored = [];

  for (const mat of allMats.rows) {
    let score = 0;
    const matName = normalize(mat.nom);
    const matTokens = tokenize(`${mat.nom} ${mat.fabricant || ''}`);

    if (matName.length > 3 && normalizedDevis.includes(matName)) {
      score += 100;
    }

    const jaccardScore = jaccard(matTokens, devisTokens);
    if (jaccardScore > 0.15) {
      score += Math.round(jaccardScore * 80);
    }

    if (mat.fabricant && foundFabricants.some(f => normalize(f) === normalize(mat.fabricant))) {
      score += 30;
    }

    if (mat.type_produit && foundTypes.some(t => normalize(t) === normalize(mat.type_produit))) {
      score += 20;
    }

    if (mat.lien_fiche_technique) score += 5;
    if (mat.lien_fiche_securite) score += 3;

    if (score >= 25) {
      scored.push({
        id: mat.id,
        nom: mat.nom,
        fabricant: mat.fabricant,
        type_produit: mat.type_produit,
        type_systeme: mat.type_systeme,
        dimension: mat.dimension,
        unite: mat.unite,
        lien_fiche_technique: mat.lien_fiche_technique,
        lien_fiche_securite: mat.lien_fiche_securite,
        score,
        confirmed: score >= 60,
        source: 'auto',
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 50);
}

module.exports = { matchMaterials };
