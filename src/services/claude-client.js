const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = 'gpt-4o';
const API_URL = 'https://api.openai.com/v1/chat/completions';

async function callOpenAI(systemPrompt, userContent, jsonSchema, strictMode = true, maxTokens = 4096) {
  if (!OPENAI_API_KEY) {
    return { error: "OPENAI_API_KEY non configurée. Ajoutez-la dans les variables d'environnement Render." };
  }

  const body = {
    model: MODEL,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  };

  if (jsonSchema) {
    if (strictMode) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'response', schema: jsonSchema, strict: true },
      };
    } else {
      body.response_format = { type: 'json_object' };
    }
  }

  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + OPENAI_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI API ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  const message = data.choices && data.choices[0] && data.choices[0].message;
  if (!message) return { error: "Pas de réponse de l'API OpenAI." };

  if (jsonSchema) {
    try {
      return JSON.parse(message.content);
    } catch (e) {
      return { error: 'Réponse JSON invalide', raw: message.content };
    }
  }

  return { text: message.content };
}

const SYSTEM_T3E = `Tu es un assistant spécialisé pour Toitures Trois Étoiles Inc. (T3E), une entreprise de couverture commerciale au Québec.
Tu connais les systèmes de toiture : BUR (asphalte et gravier), Soprasmart (panneau laminé), Soprafix (fixation mécanique), Colvent, EPDM/PVC, TPO/PVC Rhinobond, Toiture Inversée, Ancestral/Patrimonial.
Tu connais les types de travaux : Réfection complète et Pleumage (réfection partielle).
Réponds toujours en français québécois professionnel.`;

const ANALYSE_DEVIS_SCHEMA = {
  type: 'object',
  properties: {
    client_nom:                   { type: 'string' },
    client_adresse:               { type: 'string' },
    client_ville:                 { type: 'string' },
    client_province:              { type: 'string' },
    client_code_postal:           { type: 'string' },
    client_contact:               { type: 'string' },
    client_telephone:             { type: 'string' },
    client_courriel:              { type: 'string' },
    projet_nom:                   { type: 'string' },
    projet_adresse:               { type: 'string' },
    systeme_toiture_recommande:   { type: 'string' },
    type_travaux_recommande:      { type: 'string' },
    superficie_pc:                { type: 'string' },
    pontage:                      { type: 'string' },
    epaisseur_isolant:            { type: 'string' },
    pente_isolant:                { type: 'string' },
    nb_drains:                    { type: 'string' },
    nb_manchons_events:           { type: 'string' },
    nb_manchons_etancheite:       { type: 'string' },
    nb_cols_cygne:                { type: 'string' },
    materiaux:                    { type: 'array', items: { type: 'string' } },
    notes:                        { type: 'string' },
    confiance:                    { type: 'string' },
  },
  required: [
    'client_nom', 'client_adresse', 'client_ville', 'client_province', 'client_code_postal',
    'client_contact', 'client_telephone', 'client_courriel',
    'projet_nom', 'projet_adresse',
    'systeme_toiture_recommande', 'type_travaux_recommande',
    'superficie_pc', 'pontage', 'epaisseur_isolant', 'pente_isolant',
    'nb_drains', 'nb_manchons_events', 'nb_manchons_etancheite', 'nb_cols_cygne',
    'materiaux', 'notes', 'confiance',
  ],
  additionalProperties: false,
};

async function analyserDevisSoumission(texteDevis) {
  if (!OPENAI_API_KEY) return { error: "OPENAI_API_KEY manquante" };

  const systemPrompt = `Tu es un chargé de projet SENIOR expert en couverture commerciale au Québec chez Toitures Trois Étoiles Inc. (T3E).
Tu remplis une SOUMISSION de toiture. Lis CHAQUE LIGNE du devis attentivement. Prends ton temps.

=== OÙ CHERCHER CHAQUE INFO (SOURCE) ===

SOURCE 1 — DEVIS PDF (le texte fourni ci-dessous) :
- client_nom : "Propriétaire", "Client", "Maître de l'ouvrage" dans le devis
- client_adresse, client_ville, client_province (défaut "QC"), client_code_postal
- client_contact : "Attention:", "Contact:", "Représentant" dans le devis
- client_telephone : "Tél", "Cellulaire" dans le devis
- client_courriel : adresse email dans le devis
- projet_nom : page de garde, en-tête, "Objet:", "Projet:" du devis
- projet_adresse : adresse du bâtiment/chantier dans le devis
- superficie_pc : "pieds carrés", "pi²", "p.c." dans le devis
- superficie_m2 : "m²" dans le devis
- bassins : liste des bassins (ex "G-4 à G-12, F-1, E-3")
- sections_devis : numéros de section (ex "07 52 21, 07 62 00")
- documents_recus, date_documents, addenda
- nb_drains, nb_drains_urgence, nb_manchons_events, nb_manchons_etancheite, nb_cols_cygne
- cout_remplacement_cp : prix $/pi² si mentionné
- cout_remplacement_isolant : prix $/pi² si mentionné

SOURCE 2 — DEVIS PDF (choix techniques à RÉSOUDRE) :
Le devis décrit le système. Tu dois CHOISIR la bonne option pour chaque "/" :
- systeme_toiture : EXACTEMENT une de : BUR, SOPRASMART, SOPRAFIX, COLVENT, EPDM_PVC, TPO_PVC_RHINOBOND, INVERSE, ANCESTRAL
  "asphalte et gravier" / "multicouche" / "4-5 plis feutre" = BUR
  "panneau laminé" / "Soprasmart" / "SOPRASMART ISO" = SOPRASMART
  "fixation mécanique" / "Soprafix" = SOPRAFIX
- type_travaux : REFECTION ou PLEUMAGE
- pontage : "acier", "bois", "béton" ou "siporex" (cherche "pontage de/d'")
- methode_adhesion : "adhésif", "asphalte", "mécanique" ou "thermosoudé"
- type_pare_vapeur : texte exact du choix (ex "2 plis de feutre #15 adhéré à l'asphalte")
- type_isolant : "polyisocyanurate" ou "polystyrène"
- epaisseur_isolant : en pouces (convertir RSI si nécessaire : RSI 5.46 ≈ 3½")
- pente_isolant : "1%" ou "2%"
- type_fibre : "fibre de bois" ou "perlite"
- epaisseur_fibre_bois : épaisseur en pouces (ex "½")
- nb_plis : "4" ou "5"
- type_membrane_finition : description du choix
- couleur_membrane : "blanche", "grise", etc.
- type_gravier : "standard 450 lbs" ou "réfléchissantes blanches 650 lbs"
- type_releves : texte du choix retenu
- materiau_solins : "acier prépeint", "acier galvanisé" ou "cuivre 16oz"
- calibre_solins : "24" ou "26"
- type_solins : description (ex "Weather XL (Vicwest)")
- cols_cygne_type : "existants" ou "Ventilateur Maximum"
- ventilateur_max : numéro de modèle si applicable
- garantie_t3e : "5 ans", "10 ans", "15 ans" ou "20 ans"
- garantie_manufacturier : "10 ans", "15 ans", "20 ans" ou "25 ans"

SOURCE 3 — NE PAS CHERCHER (fixe ou vide) :
- NOM entrepreneur = toujours "Toitures Trois Étoiles" (NE PAS RETOURNER)
- SPÉCIALITÉ = toujours "COUVREUR" (NE PAS RETOURNER)
- ADRESSE entrepreneur = toujours "7550 Rue Saint-Patrick" (NE PAS RETOURNER)
- type_panneau_support, type_drain, rsi_minimum : retourne "" si pas dans le devis

=== RÈGLES ===
1. CHAQUE champ qui vient du DEVIS doit être rempli si l'info existe — lis le texte en entier
2. Pour les quantités sans nombre explicite ("voir plans"), retourne "les"
3. NE RETOURNE PAS les champs fixes (NOM, SPÉCIALITÉ, ADRESSE) — ils sont déjà dans le template
4. confiance : "haute", "moyenne" ou "basse"
5. notes : observations importantes trouvées dans le devis`;

  const userContent = `TEXTE COMPLET DU DEVIS (fouille CHAQUE section) :
───────────────────────────────────────
${texteDevis}
───────────────────────────────────────

Retourne un JSON avec TOUS les champs remplis.
Pour chaque choix "/", CHOISIS la bonne option selon le devis.
NE LAISSE AUCUN CHAMP VIDE si l'info est dans le devis.`;

  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_API_KEY },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('OpenAI ' + resp.status + ': ' + txt.substring(0, 300));
  }

  const data = await resp.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) return { error: 'Pas de réponse OpenAI' };

  try {
    return JSON.parse(content);
  } catch (e) {
    console.error('[IA Soumission] JSON invalide:', content.substring(0, 500));
    return { error: 'Réponse JSON invalide', raw: content };
  }
}

async function analyserDevis(texteDevis, infosUtilisateur) {
  const userContent = `Analyse ce devis de toiture et extrais toutes les informations pertinentes.

INFORMATIONS FOURNIES PAR L'UTILISATEUR :
${infosUtilisateur || 'Aucune'}

TEXTE DU DEVIS :
${texteDevis || 'Aucun devis fourni'}

Extrais : client, adresse, superficie, matériaux, quantités, système de toiture recommandé.
Pour systeme_toiture_recommande, utilise EXACTEMENT une de ces valeurs : BUR, SOPRASMART, SOPRAFIX, COLVENT, EPDM_PVC, TPO_PVC_RHINOBOND, INVERSE, ANCESTRAL
Pour type_travaux_recommande : REFECTION ou PLEUMAGE
Pour confiance : "haute", "moyenne", ou "basse"
Si une info n'est pas trouvée, retourne une chaîne vide "".`;

  return callOpenAI(SYSTEM_T3E, userContent, ANALYSE_DEVIS_SCHEMA, true);
}

// Les bordereaux uploadés viennent de firmes d'architectes différentes, chacune
// avec son propre gabarit (libellés, mise en page, champs combinés/dupliqués).
// Plutôt que de chercher un texte exact, on donne à l'IA la liste numérotée des
// textes du document et elle indique après quel texte insérer chaque valeur —
// utilisé seulement pour les champs que la recherche exacte n'a pas trouvés.
async function mapperChampsBordereau(runsTexte, champsAPlacer) {
  if (!OPENAI_API_KEY) return null;

  const cles = Object.keys(champsAPlacer);
  if (cles.length === 0) return null;

  const schema = {
    type: 'object',
    properties: Object.fromEntries(cles.map(k => [k, { type: ['integer', 'null'] }])),
    required: cles,
    additionalProperties: false,
  };

  const systemPrompt = `Tu analyses un bordereau de transmission (formulaire Word rempli par un sous-traitant en couverture) pour trouver où écrire des informations manquantes.
On te donne la liste numérotée de tous les textes visibles du document, dans l'ordre. Pour chaque champ demandé, réponds avec l'index du texte (libellé) juste après lequel sa valeur doit être écrite, ou null si aucun endroit pertinent n'existe dans ce document.
RÈGLE IMPORTANTE : préfère toujours un libellé de champ précis qui se termine par ":" (ex: "Nom :", "Coordonnées :", "Responsable :") plutôt qu'un titre de section en majuscules sans deux-points (ex: "SOUS-TRAITANT", "FOURNISSEUR", "ENTREPRENEUR") — le titre de section sert seulement à savoir QUEL groupe de champs ":" lui appartient, jamais à recevoir directement une valeur.
Utilise ces titres de section comme contexte pour choisir la bonne occurrence quand un libellé comme "Nom :" apparaît plusieurs fois dans le document — FOURNISSEUR/FABRICANT va sous le "Nom :" de la section fournisseur/manufacturier, jamais sous celui de SOUS-TRAITANT ou ENTREPRENEUR (qui désignent T3E elle-même).
EXCEPTION : certains champs demandés (ex: ARCHITECTE, NOM_ETABLISSEMENT) correspondent eux-mêmes à un titre de section ou une case du document (ex: un bloc "ARCHITECTE" tout seul, sans sous-champ ":" en dessous, prévu pour recevoir directement le nom/coordonnées de la firme). Dans ce cas précis — quand AUCUN sous-champ ":" n'existe sous ce titre pour ce type d'information — utilise directement ce titre comme point d'insertion.
Si deux champs correspondent au même libellé combiné (ex: "Devis (section et article)"), donne le même index aux deux.
Ne réponds jamais avec un index qui n'est pas un libellé (évite les longs paragraphes de texte légal).`;

  const userContent = `Textes du document (index) texte :
${runsTexte.map((t, i) => `[${i}] ${t}`).join('\n')}

Champs à placer :
${cles.map(k => `- ${k} = "${champsAPlacer[k]}"`).join('\n')}`;

  try {
    const result = await callOpenAI(systemPrompt, userContent, schema, true);
    if (result.error) {
      console.error('[claude-client] Mapping bordereau échoué:', result.error);
      return null;
    }
    return result;
  } catch (e) {
    console.error('[claude-client] Mapping bordereau échoué:', e.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
//  MANUEL DE FIN DE CHANTIER — extraction depuis le devis du projet
// ══════════════════════════════════════════════════════════════
const ANALYSE_MANUEL_SCHEMA = {
  type: 'object',
  properties: {
    NOM_DU_PROJET:          { type: 'string' },
    CLIENT:                 { type: 'string' },
    ADRESSE_PROJET:         { type: 'string' },
    PROPRIETAIRE:           { type: 'string' },
    CONSULTANT:             { type: 'string' },
    ENTREPRENEUR_GENERAL:   { type: 'string' },
    FOURNISSEUR_1:          { type: 'string' },
    FOURNISSEUR_2:          { type: 'string' },
    FOURNISSEUR_3:          { type: 'string' },
    FOURNISSEUR_4:          { type: 'string' },
    SOUS_TRAITANT_1:        { type: 'string' },
    SOUS_TRAITANT_2:        { type: 'string' },
    DESCRIPTION_TRAVAUX:    { type: 'string' },
    SURFACE_GARANTIE:       { type: 'string' },
    DUREE_GARANTIE:         { type: 'string' },
    confiance:              { type: 'string' },
  },
  required: [
    'NOM_DU_PROJET', 'CLIENT', 'ADRESSE_PROJET',
    'PROPRIETAIRE', 'CONSULTANT', 'ENTREPRENEUR_GENERAL',
    'FOURNISSEUR_1', 'FOURNISSEUR_2', 'FOURNISSEUR_3', 'FOURNISSEUR_4',
    'SOUS_TRAITANT_1', 'SOUS_TRAITANT_2',
    'DESCRIPTION_TRAVAUX', 'SURFACE_GARANTIE', 'DUREE_GARANTIE', 'confiance',
  ],
  additionalProperties: false,
};

const SYSTEM_MANUEL = `Tu es un chargé de projet SENIOR expert en couverture commerciale au Québec chez Toitures Trois Étoiles Inc. (T3E).
Tu remplis un MANUEL DE FIN DE CHANTIER à partir du devis de toiture d'un projet déjà réalisé par T3E.

=== OÙ CHERCHER CHAQUE INFO (le devis fourni) ===
- NOM_DU_PROJET : page de garde, en-tête, "Projet :", "Objet :"
- CLIENT : nom du propriétaire/établissement/entité qui a commandé les travaux (ex: "Cadillac Fairview", "Ontrea Inc", un nom d'école ou d'immeuble)
- ADRESSE_PROJET : adresse du bâtiment/chantier (PAS l'adresse de T3E)
- PROPRIETAIRE : nom de l'entreprise propriétaire + adresse + téléphone si mentionnés, sous la forme "Nom — Adresse — Téléphone" (compose ce que tu trouves, laisse vide ce qui manque)
- CONSULTANT : nom de la firme d'architectes/ingénieurs qui a préparé le devis + coordonnées si mentionnées, même format "Nom — Adresse — Téléphone"
- ENTREPRENEUR_GENERAL : nom de l'entrepreneur général du chantier s'il est mentionné (souvent absent des devis d'architecte — retourne "" si absent, ne jamais confondre avec T3E qui est l'entrepreneur COUVREUR, pas général)
- FOURNISSEUR_1, FOURNISSEUR_2, FOURNISSEUR_3, FOURNISSEUR_4 : TOUS les fournisseurs/fabricants de matériaux distincts mentionnés dans le devis (ex: "Soprema" pour la membrane, "CGC" pour les panneaux, un fournisseur de bardeau/évents/mécanique s'il y en a un autre), sous la forme "Nom — Adresse — Téléphone" si ces coordonnées sont dans le devis, sinon juste le nom. Un fournisseur par champ, du plus important au moins important. Laisse les champs vides s'il y a moins de 4 fournisseurs distincts identifiables — n'invente rien et ne répète pas le même fournisseur dans deux champs.
- SOUS_TRAITANT_1, SOUS_TRAITANT_2 : sous-traitants mentionnés dans le devis pour des travaux connexes à la couverture (ex: mécanique, électricité, maçonnerie, étanchéité de joints) si le devis en nomme explicitement. Retourne "" si aucun sous-traitant n'est mentionné — ne confonds jamais un fournisseur de matériaux avec un sous-traitant.
- DESCRIPTION_TRAVAUX : la section LA PLUS IMPORTANTE du manuel. Tu dois TRANSCRIRE ET DÉVELOPPER, de façon EXHAUSTIVE, TOUT ce que l'extrait du devis fourni décrit sur la toiture — ne résume JAMAIS, ne raccourcis JAMAIS, n'omets AUCUN détail technique présent dans le texte fourni. Comporte-toi comme un chargé de projet senior qui relit chaque paragraphe pertinent du devis et le retranscrit fidèlement et intégralement dans le manuel, en l'organisant et le complétant du mieux possible.
  Format : une ligne par composante/sujet, séparées par des retours à la ligne (\\n), sous la forme "Nom de la composante : détail complet du devis". Couvre AU MINIMUM, si le devis en parle (n'omets une ligne QUE si le devis n'en parle vraiment pas du tout) :
  1. Pare-vapeur / coupe-vapeur (produit exact, méthode de pose, recouvrements)
  2. Isolant (produit exact, épaisseur totale, nombre de rangs, pente, méthode de fixation/adhésif utilisé, valeur RSI si mentionnée)
  3. Panneau de support / substrat (produit exact, épaisseur, méthode de fixation, quantité de fixations si mentionnée)
  4. Membrane de base (produit exact, méthode de pose : collée/soudée/mécanique, recouvrements)
  5. Membrane de finition (produit exact, couleur, méthode de pose, granulat si applicable)
  6. Relevés et solins (produit exact, hauteur, emplacements précis, matériau et calibre des solins métalliques)
  7. Drains, évents, cols de cygne et autres accessoires mécaniques (quantité, type, emplacement)
  8. Joints d'expansion, joints de contrôle, cants/bandes de transition si mentionnés
  9. Adhésifs, primaires, produits d'étanchéité complémentaires mentionnés
  10. Toute exigence particulière du devis (résistance au vent/soulèvement, cote de résistance au feu, méthode d'installation spécifique, séquence des travaux, essais/inspections requis)
  N'INVENTE RIEN qui n'est pas dans l'extrait fourni, mais SOIS EXHAUSTIF sur tout ce qui s'y trouve — vise un texte LONG et COMPLET (plusieurs lignes détaillées par composante si le devis le permet), pas une liste minimaliste.
- SURFACE_GARANTIE : superficie totale de la toiture couverte par les travaux (ex: "12 500 pi²"), si mentionnée dans le devis. Retourne "" si absente.
- DUREE_GARANTIE : durée de la garantie T3E sur la main-d'œuvre/matériaux si le devis la précise (ex: "10 ans", "15 ans"). Ne confonds pas avec la garantie du fabricant. Retourne "" si absente du devis — ce champ sera alors rempli manuellement.

=== RÈGLES ===
- NE RETOURNE JAMAIS les coordonnées de T3E elle-même (7550 Rue Saint-Patrick, etc.) dans PROPRIETAIRE/CONSULTANT/ENTREPRENEUR_GENERAL — T3E est l'entrepreneur couvreur, pas un des rôles ci-dessus
- Si une info n'est pas dans le devis, retourne une chaîne vide ""
- confiance : "haute", "moyenne" ou "basse" selon la clarté du devis fourni`;

// Les devis font souvent plusieurs centaines de pages — envoyer le texte
// intégral dépasse systématiquement la limite OpenAI de 30 000 tokens/minute
// du compte T3E (ex: un devis de 550 pages ≈ 132 000 tokens, refusé en 429).
// Solution (même principe que extraireContextePertinent dans bordereaux.js) :
// ne garder que la page de garde (infos projet/client/intervenants) + la
// section de devis la plus pertinente pour la toiture (composition réelle),
// détectée par mots-clés, plutôt que le document complet.
const MOTS_CLES_TOITURE = [
  'membrane', 'toiture', 'couverture', 'isolant', 'pare-vapeur', 'pare vapeur',
  'bardeau', 'soprema', 'sopra', 'bitume', 'étanchéité', 'etancheite', 'relevé', 'releve',
];

// Budget total (en caracteres) reserve au CONTENU du devis (hors page de
// garde), reparti sur PLUSIEURS sections pertinentes plutot qu'une seule —
// un devis de toiture reel couvre generalement plusieurs divisions CSI
// distinctes (isolation 07 21 00, membrane 07 52 00, solins/tolerie 07 62 00,
// accessoires de toiture 07 71 00, etc.) et l'IA doit TOUTES les voir pour
// produire une description exhaustive. ~56000 caracteres ≈ 14000 tokens,
// laisse largement la place au system prompt + a une reponse tres detaillee
// tout en restant sous la limite de 30 000 tokens/minute du compte T3E.
const BUDGET_TOTAL_SECTIONS = 56000;
const CAP_PAR_SECTION = 20000;

function extraireContextePourManuel(texteDevis) {
  const morceaux = ['=== PAGE DE GARDE / SCEAUX ===\n' + texteDevis.substring(0, 4000)];

  // Marqueur fiable de DEBUT de section, observe dans les devis quebecois
  // type CIMAISE/AMCQ : "Section 07 52 21 ... Page 1 de 29"
  const debutSectionRegex = /Section\s+((?:0[5-9])\s?\d{2}\s?\d{2})[^\n]*\r?\n[^\n]*Page\s*1\s*de\s*\d+/gi;
  const positions = [];
  const vus = new Set();
  let m;
  while ((m = debutSectionRegex.exec(texteDevis))) {
    const numero = m[1].replace(/\s/g, '');
    if (vus.has(numero)) continue;
    vus.add(numero);
    positions.push({ numero, index: m.index });
  }
  positions.sort((a, b) => a.index - b.index);

  if (positions.length === 0) {
    // Format non standard : pas de sections detectees, on cherche juste la
    // premiere occurrence d'un mot-cle toiture et on prend une large fenetre autour.
    const texteLower = texteDevis.toLowerCase();
    let idxMotCle = -1;
    for (const mot of MOTS_CLES_TOITURE) {
      const idx = texteLower.indexOf(mot);
      if (idx !== -1 && (idxMotCle === -1 || idx < idxMotCle)) idxMotCle = idx;
    }
    const debut = idxMotCle !== -1 ? Math.max(0, idxMotCle - 500) : 4000;
    morceaux.push('=== EXTRAIT (mots-cles toiture) ===\n' + texteDevis.substring(debut, debut + BUDGET_TOTAL_SECTIONS));
    return morceaux.join('\n\n---\n\n');
  }

  // Score CHAQUE section par densite de mots-cles toiture, puis retient TOUTES
  // celles qui ont au moins un mot-cle (pas seulement la meilleure) — la
  // composition d'une toiture est presque toujours decrite sur plusieurs
  // sections/divisions differentes du devis, pas une seule.
  const sectionsScorees = [];
  for (let i = 0; i < positions.length; i++) {
    const debut = positions[i].index;
    const fin = i + 1 < positions.length ? positions[i + 1].index : texteDevis.length;
    const apercu = texteDevis.substring(debut, Math.min(fin, debut + 3000)).toLowerCase();
    const score = MOTS_CLES_TOITURE.reduce((acc, mot) => acc + (apercu.includes(mot) ? 1 : 0), 0);
    if (score > 0) sectionsScorees.push({ debut, fin, numero: positions[i].numero, score });
  }
  sectionsScorees.sort((a, b) => b.score - a.score);

  if (sectionsScorees.length === 0) {
    // Aucune section ne matche des mots-cles toiture : on prend la 1ere section par defaut
    const debut = positions[0].index;
    const fin = positions.length > 1 ? positions[1].index : texteDevis.length;
    morceaux.push('=== PREMIERE SECTION DU DEVIS (fallback) ===\n' + texteDevis.substring(debut, fin).substring(0, BUDGET_TOTAL_SECTIONS));
    return morceaux.join('\n\n---\n\n');
  }

  let budgetRestant = BUDGET_TOTAL_SECTIONS;
  for (const s of sectionsScorees) {
    if (budgetRestant <= 0) break;
    const texteSection = texteDevis.substring(s.debut, s.fin).substring(0, Math.min(CAP_PAR_SECTION, budgetRestant));
    morceaux.push(`=== SECTION ${s.numero} (toiture, score mots-clés: ${s.score}) ===\n` + texteSection);
    budgetRestant -= texteSection.length;
  }

  return morceaux.join('\n\n---\n\n');
}

async function analyserDevisManuel(texteDevis) {
  const contexte = extraireContextePourManuel(texteDevis || '');
  const userContent = `EXTRAIT PERTINENT DU DEVIS (page de garde + section toiture — pas le texte intégral, trop volumineux) :
───────────────────────────────────────
${contexte}
───────────────────────────────────────

Retourne un JSON avec tous les champs demandés, en français.`;

  return callOpenAI(SYSTEM_MANUEL, userContent, ANALYSE_MANUEL_SCHEMA, true, 8000);
}

function isConfigured() {
  return !!OPENAI_API_KEY;
}

module.exports = { analyserDevis, analyserDevisSoumission, analyserDevisManuel, mapperChampsBordereau, isConfigured };
