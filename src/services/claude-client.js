const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = 'gpt-5';
const API_URL = 'https://api.openai.com/v1/chat/completions';

async function callOpenAI(systemPrompt, userContent, jsonSchema, strictMode = true, maxTokens = 4096) {
  if (!OPENAI_API_KEY) {
    return { error: "OPENAI_API_KEY non configurée. Ajoutez-la dans les variables d'environnement Render." };
  }

  const body = {
    model: MODEL,
    max_completion_tokens: maxTokens,
    // gpt-5 (modele de raisonnement) ne supporte que la temperature par
    // defaut (1) -- envoyer temperature:0.1 (utile avec gpt-4o pour reduire
    // la variance d'extraction) renvoie une erreur 400 "unsupported_value"
    // avec ce modele. Pas de parametre = comportement par defaut du modele.
    // reasoning_effort "low" : ces appels sont de l'extraction structuree
    // (schema JSON strict), pas un probleme de raisonnement complexe -- au
    // niveau de raisonnement par defaut, une extraction sur un gros devis a
    // depasse les 60s de la fonction Vercel (FUNCTION_INVOCATION_TIMEOUT,
    // voir vercel.json) avant meme de repondre.
    reasoning_effort: 'low',
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
Chaque texte peut porter une annotation "[bloc: TITRE-DE-SECTION]" indiquant à quel bloc du formulaire il appartient (ex: "Nom :   [bloc: FOURNISSEUR]"). Cette annotation est ta source de vérité pour choisir la bonne occurrence d'un libellé répété — fie-toi à elle avant toute autre déduction. L'annotation ne fait PAS partie du texte du document.
RÈGLE IMPORTANTE : préfère toujours un libellé de champ précis qui se termine par ":" (ex: "Nom :", "Coordonnées :", "Responsable :") plutôt qu'un titre de section en majuscules sans deux-points (ex: "SOUS-TRAITANT", "FOURNISSEUR", "ENTREPRENEUR") — le titre de section sert seulement à savoir QUEL groupe de champs ":" lui appartient, jamais à recevoir directement une valeur.
Utilise ces titres de section comme contexte pour choisir la bonne occurrence quand un libellé comme "Nom :" apparaît plusieurs fois dans le document — FOURNISSEUR/FABRICANT va sous le "Nom :" de la section fournisseur/manufacturier, jamais sous celui de SOUS-TRAITANT ou ENTREPRENEUR (qui désignent T3E elle-même).
EXCEPTION : certains champs demandés (ex: ARCHITECTE, NOM_ETABLISSEMENT) correspondent eux-mêmes à un titre de section ou une case du document (ex: un bloc "ARCHITECTE" tout seul, sans sous-champ ":" en dessous, prévu pour recevoir directement le nom/coordonnées de la firme). Dans ce cas précis — quand AUCUN sous-champ ":" n'existe sous ce titre pour ce type d'information — utilise directement ce titre comme point d'insertion.
Si deux champs correspondent au même libellé combiné (ex: "Devis (section et article)"), donne le même index aux deux.
Ne réponds jamais avec un index qui n'est pas un libellé (évite les longs paragraphes de texte légal).
RÈGLE STRICTE : si AUCUN emplacement de la BONNE section n'existe pour un champ (ex: FABRICANT alors que le document n'a aucune case Fabricant/Manufacturier), réponds null pour ce champ — ne le place JAMAIS dans une section d'un autre intervenant (mettre le fabricant sous SOUS-TRAITANT ou ENTREPRENEUR est une erreur grave sur un document officiel). null vaut toujours mieux qu'une mauvaise section.
Ne donne jamais à deux champs DIFFÉRENTS (hors cas du libellé combiné ci-dessus) le même index : leurs valeurs s'écriraient l'une par-dessus l'autre.`;

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
- DESCRIPTION_TRAVAUX : résumé BREF de la portée des travaux de toiture réalisés — 3 à 6 phrases maximum, un seul paragraphe (pas de liste à puces, pas de retours à la ligne), dans le style d'un manuel de référence concis. Exemple de longueur/ton attendu : "Réfection complète de la toiture en bardeaux d'asphalte de couleur gris ardoise de la Résidence X, incluant les membranes de sous-couche et d'étanchéité, les solins et gouttières en tôle, ainsi que les travaux d'étanchéité connexes."
  Nomme uniquement : (1) le type de système de toiture installé (ex. bardeaux d'asphalte, membrane élastomère, TPO, BUR), (2) les 2-3 produits/composantes principales réellement posés, (3) la portée générale (réfection complète ou partielle). NE TRANSCRIS PAS le devis phrase par phrase et NE DÉTAILLE PAS chaque composante une par une (pare-vapeur, isolant, solins, drains, etc., produit par produit) — ce niveau de détail appartient aux fiches techniques jointes au manuel, pas à ce résumé. Privilégie toujours le produit RÉELLEMENT installé en toiture (section technique principale de couverture, généralement la plus longue du devis, sous "PARTIE 2 PRODUITS") plutôt qu'un produit secondaire ou incidental mentionné dans une section annexe courte (ex: isolant en matelas des parapets, panneau de béton d'un muret) — ne confonds jamais les deux.
- SURFACE_GARANTIE : superficie totale de la toiture couverte par les travaux (ex: "12 500 pi²"), si mentionnée dans le devis. Retourne "" si absente.
- DUREE_GARANTIE : durée de la garantie T3E sur la main-d'œuvre/matériaux si le devis la précise (ex: "10 ans", "15 ans"). Ne confonds pas avec la garantie du fabricant. Retourne "" si absente du devis — ce champ sera alors rempli manuellement.

=== RÈGLES ===
- NE RETOURNE JAMAIS les coordonnées de T3E elle-même (7550 Rue Saint-Patrick, etc.) dans PROPRIETAIRE/CONSULTANT/ENTREPRENEUR_GENERAL — T3E est l'entrepreneur couvreur, pas un des rôles ci-dessus
- Si une info n'est pas dans le devis, retourne une chaîne vide ""
- INTERDICTION ABSOLUE d'écrire des réponses paresseuses comme "Voir section 07 21 16", "Voir section X", "Se référer au devis" ou toute autre forme de renvoi sans contenu — le manuel doit pouvoir être lu SEUL, sans avoir le devis sous les yeux. Si tu identifies la bonne section mais qu'elle ne fait que renvoyer à une autre section, VA CHERCHER le contenu réel dans cette autre section de l'extrait fourni et transcris-le. Si le contenu réel n'est vraiment nulle part dans l'extrait, écris "" pour cette ligne plutôt qu'un renvoi vide.
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
  // Divisions connexes fréquemment décrites dans le même devis qu'un projet de
  // toiture (métaux, lanterneaux, revêtement mural, coupe-feu, drainage) — sans
  // ces mots-clés, extraireContextePourManuel() ignore ces sections et l'IA ne
  // peut jamais les transcrire dans DESCRIPTION_TRAVAUX, même si le prompt les
  // demande explicitement.
  'solin', 'drain', 'évent', 'event', 'col-de-cygne', 'col de cygne', 'lanterneau',
  'mur-rideau', 'mur rideau', 'parement métallique', 'parement metallique',
  'revêtement métallique', 'revetement metallique', 'échelle', 'echelle',
  'chaperon', 'rampe autoportante', 'garde-corps', 'coupe-feu', 'pare-fumée', 'pare-fumee',
  'vicwest', 'murphco', 'rockwool',
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
const CAP_PAR_SECTION = 42000;

// Les devis québécois type CCDC/AMCQ structurent chaque section en PARTIE 1
// GÉNÉRALITÉS (qualité, garanties, transport, conditions de mise en œuvre —
// JAMAIS les produits réellement installés) / PARTIE 2 PRODUITS (les produits
// nommés — ce qui compte le plus pour le manuel) / PARTIE 3 EXÉCUTION (méthode
// de pose). Constaté le 2026-07-06 sur un vrai devis (section 07 52 21, 29
// pages) : PARTIE 1 seule dépasse déjà l'ancien plafond de 20 000 caractères,
// donc l'IA ne voyait JAMAIS PARTIE 2 et inventait des réponses du type "Voir
// section X" ou piochait des produits secondaires dans de petites sections
// annexes plutôt que les produits réels (Sopraply Base 520, Sopra-ISO, drains
// Murphco, etc., tous absents du résultat alors que présents au devis).
function extraireSectionUtile(texteSection, capMax) {
  const idxPartie2 = texteSection.search(/PARTIE\s*2\b/i);
  if (idxPartie2 === -1 || idxPartie2 < 300) {
    // Pas de structure PARTIE 1/2/3 détectée (section courte ou atypique) :
    // comportement simple, on garde le début tel quel.
    return texteSection.substring(0, capMax);
  }
  const prefixe = texteSection.substring(0, 300);
  const partie1 = texteSection.substring(300, idxPartie2);

  // La durée/portée de la garantie est presque toujours nommée dans PARTIE 1
  // GÉNÉRALITÉS (ex: "garantie de 10 ans", "warranty period") — avant ce
  // correctif, PARTIE 1 était supprimée en bloc, ce qui rendait SURFACE_GARANTIE
  // et DUREE_GARANTIE systématiquement vides même quand le devis les précisait.
  // On extrait maintenant un court passage autour de la première mention de
  // garantie avant d'omettre le reste (qualité/transport, non pertinent).
  let extraitGarantie = '';
  const idxGarantie = partie1.search(/garantie|warranty/i);
  if (idxGarantie !== -1) {
    const debut = Math.max(0, idxGarantie - 100);
    const fin = Math.min(partie1.length, idxGarantie + 700);
    extraitGarantie = '\n[EXTRAIT GARANTIE (PARTIE 1 GÉNÉRALITÉS)]\n' + partie1.substring(debut, fin).trim() + '\n';
  }

  const budgetRestant = Math.max(0, capMax - prefixe.length - extraitGarantie.length);
  const suite = texteSection.substring(idxPartie2, idxPartie2 + budgetRestant);
  return prefixe + extraitGarantie + '\n[...reste de PARTIE 1 GÉNÉRALITÉS omis (qualité/transport, non pertinent pour la composition installée)...]\n' + suite;
}

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
    const texteSectionComplet = texteDevis.substring(s.debut, s.fin);
    const capSection = Math.min(CAP_PAR_SECTION, budgetRestant);
    const texteSection = extraireSectionUtile(texteSectionComplet, capSection);
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

  return callOpenAI(SYSTEM_MANUEL, userContent, ANALYSE_MANUEL_SCHEMA, true, 10000);
}

// ── Fournisseurs à partir des fiches techniques (FT) ──
// Le devis liste parfois des matériaux prévus qui ne sont finalement pas
// installés (produit remplacé en chantier, substitution acceptée par
// l'architecte) — les FICHES TECHNIQUES réellement approuvées et jointes au
// manuel sont la source fiable de "qu'est-ce qui a vraiment été posé". Cette
// fonction en extrait le(s) fabricant(s), à privilégier sur FOURNISSEUR_1..4
// issus du devis quand des fiches techniques sont disponibles.
const ANALYSE_FOURNISSEURS_FT_SCHEMA = {
  type: 'object',
  properties: {
    FOURNISSEUR_1: { type: 'string' },
    FOURNISSEUR_2: { type: 'string' },
    FOURNISSEUR_3: { type: 'string' },
    FOURNISSEUR_4: { type: 'string' },
  },
  required: ['FOURNISSEUR_1', 'FOURNISSEUR_2', 'FOURNISSEUR_3', 'FOURNISSEUR_4'],
  additionalProperties: false,
};

const SYSTEM_FOURNISSEURS_FT = `Tu es un chargé de projet SENIOR en couverture commerciale chez Toitures Trois Étoiles Inc. (T3E).
On te donne le texte extrait de plusieurs FICHES TECHNIQUES (fiches d'identification/dessins d'atelier approuvés) d'un même chantier de toiture. Ces fiches représentent les produits RÉELLEMENT installés — contrairement au devis, qui liste parfois des produits finalement remplacés ou non utilisés en chantier.

=== TÂCHE ===
Identifie jusqu'à 4 fournisseurs/fabricants DISTINCTS parmi ces fiches (ex: Soprema, BP, Adfast, Rust-Oleum, Condor Chimiques, IKO, GAF, etc.).
Pour chacun, retourne "Nom du fabricant — Adresse — Téléphone" si ces coordonnées apparaissent dans l'en-tête/pied de page de la fiche, sinon juste "Nom du fabricant — Nom du produit principal".
Un fournisseur par champ, du plus important (matériau principal de toiture : membrane/bardeau) au moins important (accessoires : scellants, clous, apprêts).
Si deux fiches viennent du même fabricant, regroupe-les sous un seul champ (ex: "BP Canada — bardeaux Mystique, membrane WeatherTex") plutôt que de répéter le fabricant.
Laisse les champs vides ("") s'il y a moins de 4 fabricants distincts identifiables — n'invente rien.
Ignore les fiches qui ne sont pas de vraies fiches techniques de produit (pages d'identification vides sans données du fabricant, pages appartenant visiblement à un autre projet).`;

async function extraireFournisseursDesFT(fiches) {
  const vide = { FOURNISSEUR_1: '', FOURNISSEUR_2: '', FOURNISSEUR_3: '', FOURNISSEUR_4: '' };
  if (!Array.isArray(fiches) || fiches.length === 0) return vide;

  const CAP_PAR_FICHE = 6000;
  const BUDGET_TOTAL_FT = 48000;
  let budgetRestant = BUDGET_TOTAL_FT;
  const morceaux = [];
  for (const f of fiches) {
    if (budgetRestant <= 0) break;
    const texte = (f.texte || '').substring(0, Math.min(CAP_PAR_FICHE, budgetRestant));
    if (!texte.trim()) continue;
    morceaux.push(`=== FICHE : ${f.nom || 'sans nom'} ===\n${texte}`);
    budgetRestant -= texte.length;
  }
  if (morceaux.length === 0) return vide;

  const userContent = `FICHES TECHNIQUES DU CHANTIER :
───────────────────────────────────────
${morceaux.join('\n\n---\n\n')}
───────────────────────────────────────

Retourne un JSON avec les 4 champs demandés, en français.`;

  const result = await callOpenAI(SYSTEM_FOURNISSEURS_FT, userContent, ANALYSE_FOURNISSEURS_FT_SCHEMA, true, 4096);
  if (result.error) {
    console.error('[claude-client] Extraction fournisseurs FT échouée:', result.error);
    return vide;
  }
  return result;
}

// ══════════════════════════════════════════════════════════════
//  APPELS D'OFFRES SEAO — infos entreprise + mapping de formulaire PDF
// ══════════════════════════════════════════════════════════════

// Extrait les informations d'entreprise T3E (NEQ, RBQ, assurances,
// certifications...) à partir d'extraits de certificats de la base de
// connaissances — calculé une fois puis mis en cache (voir seao-autofill.js),
// pas ré-analysé à chaque formulaire.
const ANALYSE_INFOS_ENTREPRISE_SCHEMA = {
  type: 'object',
  properties: {
    NEQ: { type: 'string' },
    RBQ: { type: 'string' },
    CCQ: { type: 'string' },
    CNESST_NUMERO: { type: 'string' },
    NOM_ENTREPRISE: { type: 'string' },
    ADRESSE_ENTREPRISE: { type: 'string' },
    TELEPHONE_ENTREPRISE: { type: 'string' },
    TELECOPIEUR_ENTREPRISE: { type: 'string' },
    SITE_WEB: { type: 'string' },
    COURRIEL_ENTREPRISE: { type: 'string' },
    TPS_TVH: { type: 'string' },
    TVQ: { type: 'string' },
    ASSURANCE_RESPONSABILITE_CIVILE: { type: 'string' },
    ASSURANCE_AUTOMOBILE: { type: 'string' },
    CAUTIONNEMENT: { type: 'string' },
    CERTIFICATIONS: { type: 'array', items: { type: 'string' } },
    SIGNATAIRE_AUTORISE: { type: 'string' },
    REPRESENTANT_NOM: { type: 'string' },
    REPRESENTANT_TITRE: { type: 'string' },
    REPRESENTANT_COURRIEL: { type: 'string' },
    REPRESENTANT_TELEPHONE: { type: 'string' },
    REPRESENTANT_CELLULAIRE: { type: 'string' },
    FORME_JURIDIQUE: { type: 'string' },
    NOMBRE_EMPLOYES_QUEBEC: { type: 'string' },
    CNESST_STATUT: { type: 'string' },
    FRANCISATION_STATUT: { type: 'string' },
    AMP_NUMERO_CLIENT: { type: 'string' },
    AMP_ECHEANCE: { type: 'string' },
    AVERTISSEMENTS: { type: 'array', items: { type: 'string' } },
    confiance: { type: 'string' },
  },
  required: [
    'NEQ', 'RBQ', 'CCQ', 'CNESST_NUMERO', 'NOM_ENTREPRISE', 'ADRESSE_ENTREPRISE', 'TELEPHONE_ENTREPRISE',
    'TELECOPIEUR_ENTREPRISE', 'SITE_WEB', 'COURRIEL_ENTREPRISE', 'TPS_TVH', 'TVQ',
    'ASSURANCE_RESPONSABILITE_CIVILE', 'ASSURANCE_AUTOMOBILE', 'CAUTIONNEMENT',
    'CERTIFICATIONS', 'SIGNATAIRE_AUTORISE', 'REPRESENTANT_NOM', 'REPRESENTANT_TITRE',
    'REPRESENTANT_COURRIEL', 'REPRESENTANT_TELEPHONE', 'REPRESENTANT_CELLULAIRE',
    'FORME_JURIDIQUE', 'NOMBRE_EMPLOYES_QUEBEC', 'CNESST_STATUT', 'FRANCISATION_STATUT',
    'AMP_NUMERO_CLIENT', 'AMP_ECHEANCE', 'AVERTISSEMENTS', 'confiance',
  ],
  additionalProperties: false,
};

const SYSTEM_INFOS_ENTREPRISE = `Tu extrais les informations d'entreprise de Toitures Trois Étoiles Inc. (T3E) à partir d'extraits de certificats/documents corporatifs, pour pré-remplir des formulaires de soumission d'appels d'offres publics (SEAO).

=== CHAMPS ===
- NEQ : Numéro d'Entreprise du Québec (10 chiffres) DE TOITURES TROIS ÉTOILES INC. — cherche "Registre des entreprises" / "NEQ". ATTENTION : la base contient aussi des documents pour une entité JURIDIQUE DIFFÉRENTE, "Service d'entretien Toitures Trois Étoiles Inc." (NEQ différent) — ne confonds jamais les deux.
- RBQ : numéro de licence RBQ (Régie du bâtiment du Québec) DE TOITURES TROIS ÉTOILES INC. spécifiquement (pas de l'entité "Service")
- CCQ : numéro de licence CCQ (Commission de la construction du Québec)
- CNESST_NUMERO : numéro d'employeur CNESST/CSST (distinct de CNESST_STATUT, qui est le statut de conformité, pas le numéro)
- NOM_ENTREPRISE, ADRESSE_ENTREPRISE, TELEPHONE_ENTREPRISE, TELECOPIEUR_ENTREPRISE, SITE_WEB, COURRIEL_ENTREPRISE : coordonnées officielles de T3E (jamais celles d'un client, d'un assureur/courtier, ou d'un tiers)
- TPS_TVH : numéro d'inscription TPS/TVH de T3E, si mentionné (distinct du NEQ et du RBQ)
- TVQ : numéro d'inscription TVQ de T3E, si mentionné
- ASSURANCE_RESPONSABILITE_CIVILE : montant de couverture + assureur si mentionné (ex: "15 000 000 $ — [assureur]")
- ASSURANCE_AUTOMOBILE : idem pour l'assurance automobile
- CAUTIONNEMENT : information de cautionnement d'exécution si disponible, sinon ""
- CERTIFICATIONS : liste courte des certifications/memberships pertinents trouvés (ex: "ISO 9001", "AMCQ", "APECQ", "NRCA", "CRCA", "Safe Contractor")
- SIGNATAIRE_AUTORISE : nom complet de la personne autorisée à signer pour T3E (président, administrateur, OU le représentant/estimateur désigné dans une résolution de compagnie — cherche dans une résolution de compagnie en priorité, sinon la personne à qui sont adressées les lettres officielles de la CNESST/OQLF/AMP)
- REPRESENTANT_NOM : nom complet de la personne désignée comme "représentant" du soumissionnaire pour CE dossier (distinct de SIGNATAIRE_AUTORISE quand un formulaire distingue les deux — ex: un estimateur nommé "représentant" alors que le signataire légal est le président). Si le site a déjà assigné un profil de représentant pour ce dossier, cette valeur est remplacée par celle du profil sélectionné — ne cherche dans les documents que si aucun profil n'est fourni.
- REPRESENTANT_TITRE : titre/fonction de cette personne (ex: "Estimateur", "Président") si trouvé
- REPRESENTANT_COURRIEL, REPRESENTANT_TELEPHONE, REPRESENTANT_CELLULAIRE : coordonnées directes de cette personne si mentionnées (souvent une adresse courriel nominative @t3e.co)
- FORME_JURIDIQUE : forme juridique de T3E si mentionnée (ex: "Société par actions, régime provincial (Québec)")
- NOMBRE_EMPLOYES_QUEBEC : nombre de salariés au Québec si mentionné (ex: "100 à 249"), utile pour les déclarations "Charte de la langue française"
- CNESST_STATUT : statut de conformité CNESST le plus récent trouvé + sa date (ex: "Conforme au 1 juillet 2026")
- FRANCISATION_STATUT : statut de francisation OQLF le plus récent (ex: "Certificat de francisation en vigueur")
- AMP_NUMERO_CLIENT : numéro de client de l'Autorité des marchés publics (AMP) pour l'autorisation de contracter, si trouvé
- AMP_ECHEANCE : date d'échéance de cette autorisation de contracter AMP, si trouvée
- AVERTISSEMENTS : liste de mises en garde COURTES et concrètes à afficher à l'utilisateur — notamment chaque fois que tu remarques un NEQ, une adresse, ou un numéro de taxes (TPS/TVQ) qui semble appartenir à une entité DIFFÉRENTE de Toitures Trois Étoiles Inc. (ex: à "Service d'entretien Toitures Trois Étoiles Inc.") dans les documents fournis — précise alors clairement que cette donnée n'a PAS été utilisée pour cette raison. Ajoute aussi un avertissement pour toute donnée requise mais introuvable de façon fiable (ex: attestation de Revenu Québec manquante). Retourne [] si rien à signaler.

=== RÈGLES ===
- Remplis TOUJOURS chaque champ avec ta meilleure estimation à partir des extraits fournis — même si l'info n'est pas mot pour mot présente, déduis-la du contexte disponible (ex: si un seul assureur/montant de couverture apparaît dans les documents, utilise-le même s'il n'est pas explicitement étiqueté "assurance responsabilité civile"). Ne retourne "" que si absolument aucune donnée exploitable n'existe dans les extraits pour ce champ précis.
- Ne réutilise JAMAIS une donnée (NEQ, RBQ, numéro de taxe, adresse) qui appartient clairement à une entité différente de "Toitures Trois Étoiles Inc." — utilise plutôt la meilleure donnée disponible pour T3E elle-même et ajoute un AVERTISSEMENT signalant l'ambiguïté, plutôt que de laisser le champ vide.
- confiance : "haute", "moyenne" ou "basse" selon la clarté des extraits fournis — utilise "basse" pour signaler une valeur déduite/approximative plutôt que de la retenir`;

async function analyserInfosEntreprise(texteCertificats) {
  const userContent = `EXTRAITS DE CERTIFICATS/DOCUMENTS CORPORATIFS T3E :
───────────────────────────────────────
${texteCertificats}
───────────────────────────────────────

Retourne un JSON avec tous les champs demandés, en français.`;

  return callOpenAI(SYSTEM_INFOS_ENTREPRISE, userContent, ANALYSE_INFOS_ENTREPRISE_SCHEMA, true, 4096);
}

// Associe les champs nommés d'un formulaire PDF (AcroForm) aux informations
// d'entreprise disponibles. Contrairement à mapperChampsBordereau() (qui
// pointe vers un INDEX de texte dans un .docx de structure inconnue), les
// champs AcroForm ont déjà un nom technique généralement semantique — on
// demande donc directement la VALEUR à inscrire (ou null), pas une position.
async function mapperChampsFormulairePdf(nomsChamps, donneesDisponibles) {
  if (!OPENAI_API_KEY) return null;
  if (!Array.isArray(nomsChamps) || nomsChamps.length === 0) return null;

  const schema = {
    type: 'object',
    properties: Object.fromEntries(nomsChamps.map((n) => [n, { type: ['string', 'null'] }])),
    required: nomsChamps,
    additionalProperties: false,
  };

  const systemPrompt = `Tu remplis un formulaire PDF de soumission (appel d'offres public au Québec) pour Toitures Trois Étoiles Inc. (T3E), à partir des informations d'entreprise disponibles ci-dessous.
Pour CHAQUE champ du formulaire (identifié par son nom technique PDF, qui reflète généralement son intitulé), retourne ta MEILLEURE valeur à inscrire — déduis-la du contexte disponible si elle n'est pas mot pour mot présente (ex: utilise le représentant désigné pour tout champ "nom du soumissionnaire"/"personne-ressource", l'adresse/coordonnées T3E pour tout champ d'adresse générique, la forme juridique ou le nombre d'employés si mentionnés même approximativement).
Retourne null UNIQUEMENT pour les champs strictement propres à CET appel d'offres précis et qu'aucune information d'entreprise ne peut combler par nature (le prix soumissionné, les exclusions techniques, une date de dépôt choisie par l'utilisateur, une quantité de matériaux) — pas parce que la correspondance est imparfaite. Dans le doute entre remplir approximativement et retourner null, remplis.`;

  const userContent = `INFORMATIONS D'ENTREPRISE DISPONIBLES :
${JSON.stringify(donneesDisponibles, null, 2)}

CHAMPS DU FORMULAIRE PDF À REMPLIR :
${nomsChamps.map((n, i) => `${i + 1}. ${n}`).join('\n')}`;

  try {
    const result = await callOpenAI(systemPrompt, userContent, schema, true, 4096);
    if (result.error) {
      console.error('[claude-client] Mapping formulaire PDF échoué:', result.error);
      return null;
    }
    return result;
  } catch (e) {
    console.error('[claude-client] Mapping formulaire PDF échoué:', e.message);
    return null;
  }
}

function isConfigured() {
  return !!OPENAI_API_KEY;
}

// ── Extraction structurée des exigences d'un appel d'offres SEAO ──────────
// Chaque champ retourné DOIT porter sa source exacte (document + page +
// extrait) et un niveau de confiance — jamais une valeur "nue". Le statut
// distingue une info clairement confirmée d'une info à vérifier ou de
// sources contradictoires (voir demande, section 1 et 10).
function champSourceSchema(champsSupplementaires = {}) {
  return {
    type: 'object',
    properties: {
      valeur: { type: 'string' },
      statut: { type: 'string', enum: ['confirme', 'a_verifier', 'contradictoire', 'non_trouve'] },
      document_source: { type: 'string' },
      page_source: { type: 'string' },
      extrait_source: { type: 'string' },
      niveau_confiance: { type: 'string', enum: ['eleve', 'moyen', 'faible'] },
      ...champsSupplementaires,
    },
    required: ['valeur', 'statut', 'document_source', 'page_source', 'extrait_source', 'niveau_confiance', ...Object.keys(champsSupplementaires)],
    additionalProperties: false,
  };
}

const MOMENT_REMISE_ENUM = [
  'avec_soumission', 'avant_adjudication', 'apres_adjudication',
  'avant_debut_travaux', 'pendant_travaux', 'fin_travaux', 'non_precise',
];

const ANALYSE_EXIGENCES_SCHEMA = {
  type: 'object',
  properties: {
    date_debut_travaux: champSourceSchema({ moment_remise: { type: 'string', enum: MOMENT_REMISE_ENUM } }),
    date_fin_travaux: champSourceSchema({ moment_remise: { type: 'string', enum: MOMENT_REMISE_ENUM } }),
    methode_depot: champSourceSchema({ moment_remise: { type: 'string', enum: MOMENT_REMISE_ENUM } }),
    cautionnement_soumission: champSourceSchema({ moment_remise: { type: 'string', enum: MOMENT_REMISE_ENUM } }),
    cautionnement_execution: champSourceSchema({ moment_remise: { type: 'string', enum: MOMENT_REMISE_ENUM } }),
    lettre_engagement: champSourceSchema({ moment_remise: { type: 'string', enum: MOMENT_REMISE_ENUM } }),
    lettre_assureur: champSourceSchema({ moment_remise: { type: 'string', enum: MOMENT_REMISE_ENUM } }),
    autres_documents: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          nom: { type: 'string' },
          obligatoire: { type: 'boolean' },
          moment_remise: { type: 'string', enum: MOMENT_REMISE_ENUM },
          statut: { type: 'string', enum: ['confirme', 'a_verifier', 'contradictoire', 'non_trouve'] },
          document_source: { type: 'string' },
          page_source: { type: 'string' },
          extrait_source: { type: 'string' },
          niveau_confiance: { type: 'string', enum: ['eleve', 'moyen', 'faible'] },
        },
        required: ['nom', 'obligatoire', 'moment_remise', 'statut', 'document_source', 'page_source', 'extrait_source', 'niveau_confiance'],
        additionalProperties: false,
      },
    },
    contradictions: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'date_debut_travaux', 'date_fin_travaux', 'methode_depot',
    'cautionnement_soumission', 'cautionnement_execution',
    'lettre_engagement', 'lettre_assureur', 'autres_documents', 'contradictions',
  ],
  additionalProperties: false,
};

const SYSTEM_EXIGENCES = `Tu analyses les documents d'un appel d'offres public au Québec (SEAO) pour Toitures Trois Étoiles Inc. (T3E, entrepreneur en couverture), afin d'en extraire les exigences administratives et contractuelles clés.

Les documents te sont fournis avec des marqueurs "===== DOCUMENT: ... =====" et "--- page N ---". Tu DOIS citer, pour chaque champ, le nom du document exact (document_source), le numéro de page si connu (page_source, chaîne vide si non déterminée), et un COURT extrait littéral (extrait_source, 1-2 phrases) qui justifie ta réponse.

=== CHAMPS ===
- date_debut_travaux / date_fin_travaux : date prévue ou condition (ex: "10 jours suivant l'ordre de commencer", "après les vacances de la construction"). Si seule une DURÉE est indiquée sans date de départ connue, mets statut="a_verifier" et précise dans valeur qu'un calcul est impossible sans date de départ confirmée.
- methode_depot : comment la soumission doit être remise (dépôt électronique SEAO, en personne, courrier, courriel, ou plusieurs méthodes) — inclus l'adresse/service/inscriptions requises si remise en personne.
- cautionnement_soumission / cautionnement_execution : type, montant (fixe ou %), durée de validité, formulaire exigé.
- lettre_engagement : lettre d'engagement d'une compagnie de cautionnement/institution financière à fournir les garanties après adjudication — type, émetteur autorisé, signatures requises.
- lettre_assureur : lettre/attestation/certificat d'assurance exigé — type, montant minimal de couverture, moment de remise.
- autres_documents : TOUS les autres documents à fournir avec la soumission ou après adjudication (expérience, licences RBQ, attestations CNESST/Revenu Québec/AMF, cautionnements de sous-traitants, échéanciers, plans de santé-sécurité, etc.) — une entrée par document distinct.
- contradictions : liste de courtes phrases signalant toute contradiction entre documents (ex: deux dates de dépôt différentes) — [] si aucune.

=== RÈGLES ===
- statut="non_trouve" avec valeur="" si l'information n'apparaît dans AUCUN document fourni — n'invente JAMAIS une date, un montant ou une exigence absente.
- statut="contradictoire" si deux documents se contredisent — dans ce cas valeur doit contenir LES DEUX valeurs trouvées, et signaler la priorité (l'addenda le plus récent prime sur les autres documents).
- statut="confirme" seulement si l'information est explicite et non ambiguë dans une source fiable (addenda, formulaire de soumission, instructions aux soumissionnaires).
- niveau_confiance="faible" pour toute information déduite plutôt que trouvée explicitement, ou si les sources se contredisent.
- Réponds en français québécois professionnel.`;

async function analyserExigencesAppelOffre(contexteDocuments) {
  const userContent = `DOCUMENTS DE L'APPEL D'OFFRES :
───────────────────────────────────────
${contexteDocuments}
───────────────────────────────────────

Retourne un JSON avec tous les champs demandés.`;

  return callOpenAI(SYSTEM_EXIGENCES, userContent, ANALYSE_EXIGENCES_SCHEMA, true, 4096);
}

// ══════════════════════════════════════════════════════════════
//  SOUMISSIONS PRIVÉES — remplissage automatique depuis appel d'offre +
//  plans + addendas uploadés directement (aucun lien SEAO/appel d'offres
//  public — voir soumission-filler.js). Même principe que
//  analyserExigencesAppelOffre/champSourceSchema : CHAQUE champ porte sa
//  source et son statut, jamais une valeur "nue". statut="non_trouve" ⇒ le
//  filler insère un marqueur [À VALIDER], jamais une valeur inventée.
// ══════════════════════════════════════════════════════════════

// Champs communs à TOUS les templates (en-tête, tableau Re:/Objet:, prix,
// exclusions, détails communs à presque tous les systèmes). Un système peut
// ne pas avoir de bullet "manchons d'étanchéité" (Ancestral) — dans ce cas le
// filler ignore simplement ce champ, il n'est jamais faux de le demander.
function champsCommuns() {
  return {
    // L'entreprise/institution qui a ÉMIS l'appel d'offre (le destinataire de
    // la lettre de soumission) — PAS l'entrepreneur général ni un
    // sous-traitant mentionné dans les documents.
    client_nom: champSourceSchema(),
    // Numéro de référence du projet/appel d'offre TEL QU'INDIQUÉ dans les
    // documents (ex: "25-190-01") — jamais le numéro interne T3E (généré
    // séparément, voir genererNumero() dans soumissions.js).
    numero_reference_projet: champSourceSchema(),
    client_adresse: champSourceSchema(),
    client_ville_province_cp: champSourceSchema(),
    client_contact: champSourceSchema(),
    client_telephone: champSourceSchema(),
    client_courriel: champSourceSchema(),
    objet_projet: champSourceSchema(), // nom réel du bassin/scope (PAS "Bassin 1" par défaut)
    superficie_pc: champSourceSchema(),
    date_documents_recus: champSourceSchema(),
    documents_recus_liste: champSourceSchema(), // ex: "Plans architecture émis 2026-03-01 (45 pages), Addenda 1 émis 2026-03-10"
    exclusions_specifiques: champSourceSchema(),
    prix_total: champSourceSchema(),
    cout_remplacement_cp: champSourceSchema(), // $/pied carré, remplacement contreplaqué
    cout_remplacement_isolant_humide: champSourceSchema(), // $/pied carré, isolant existant humide/endommagé — présent sur BUR et EPDM-PVC seulement, non_trouve ailleurs (attendu)
    nb_drains: champSourceSchema(),
    nb_manchons_events: champSourceSchema(),
    nb_manchons_etancheite: champSourceSchema(), // Chem-Curbs — absent du système Ancestral, statut=non_trouve attendu
    flashing_materiau_calibre: champSourceSchema(), // ex: "acier prépeint calibre 24" ou "cuivre 16oz"
    gooseneck_ou_ventilateur: champSourceSchema(), // quantité cols de cygne "tel qu'existant" OU modèle Ventilateur Maximum
  };
}

// Champs propres à chaque famille de template (voir le plan d'implémentation
// pour le détail des trous réels par système, extraits directement des 18
// fichiers). `valeur` doit toujours contenir le texte EXACT de l'option
// choisie parmi un choix "/" (ex: "acier", pas "bois / acier / béton"), pour
// que le filler puisse faire un remplacement littéral de l'option retenue.
const CHAMPS_PAR_SYSTEME = {
  BUR_REFECTION: {
    pontage_materiau: champSourceSchema(), // bois | acier | béton | siporex
    pare_vapeur_type: champSourceSchema(),
    isolant_base_epaisseur: champSourceSchema(),
    pente_isolant: champSourceSchema(),
    isolant_materiau: champSourceSchema(),
    fibre_bois_ou_perlite: champSourceSchema(),
    fibre_bois_epaisseur: champSourceSchema(),
    nb_plis_ou_membrane_alt: champSourceSchema(), // "4", "5", ou "deux (2) plis de membranes élastomères..."
    gravier_type: champSourceSchema(), // standard 450 lbs | réfléchissant 650 lbs
    releves_composition: champSourceSchema(),
  },
  BUR_PLEUMAGE: {
    pente_isolant: champSourceSchema(),
    isolant_materiau: champSourceSchema(),
    fibre_bois_ou_perlite: champSourceSchema(),
    fibre_bois_epaisseur: champSourceSchema(),
    nb_plis_ou_membrane_alt: champSourceSchema(),
    gravier_type: champSourceSchema(),
    releves_composition: champSourceSchema(),
  },
  COLVENT_REFECTION: {
    description_toiture_existante: champSourceSchema(),
    pontage_materiau: champSourceSchema(), // bois | acier | béton | syporex | coupe-vapeur existant
    pare_vapeur_type: champSourceSchema(),
    pente_isolant: champSourceSchema(),
    isolant_materiau: champSourceSchema(),
    isolant_methode_fixation: champSourceSchema(),
    isolant_base_epaisseur: champSourceSchema(),
    releves_materiau: champSourceSchema(), // contreplaqué ½'' | asphaltique ½''
    membrane_couleur: champSourceSchema(), // grise | réfléchissante blanche
  },
  EPDM_PVC_PLEUMAGE: {
    pente_isolant: champSourceSchema(),
    isolant_materiau: champSourceSchema(),
    membrane_type: champSourceSchema(), // EPDM 60mils | PVC 60mils
    ballast_type: champSourceSchema(), // pierre de rivière | géotextile + gravier réfléchissant
  },
  INVERSE_REFECTION: {
    description_toiture_existante: champSourceSchema(),
    methode_membrane: champSourceSchema(), // 2 plis thermosoudés | membrane liquide Hydrotech
    releves_materiau: champSourceSchema(),
    membrane_couleur: champSourceSchema(),
    xps_epaisseur: champSourceSchema(),
    ballast_type: champSourceSchema(),
  },
  SOPRAFIX_REFECTION: {
    pontage_materiau: champSourceSchema(), // bois | acier
    pare_vapeur_type: champSourceSchema(),
    isolant_epaisseur: champSourceSchema(),
    pente_isolant: champSourceSchema(),
    isolant_materiau: champSourceSchema(),
    releves_materiau: champSourceSchema(),
    membrane_couleur: champSourceSchema(),
  },
  SOPRASMART_REFECTION: {
    pontage_materiau: champSourceSchema(), // bois | acier
    coupe_vapeur_type: champSourceSchema(),
    isolant_sopraiso_epaisseur: champSourceSchema(),
    panneau_support_epaisseur: champSourceSchema(),
    membrane_couleur: champSourceSchema(),
  },
  TPO_PVC_RHINOBOND: {
    pontage_materiau: champSourceSchema(), // bois | acier
    pare_vapeur_type: champSourceSchema(),
    isolant_epaisseur: champSourceSchema(),
    pente_isolant: champSourceSchema(),
    isolant_materiau: champSourceSchema(),
    membrane_type: champSourceSchema(), // TPO | PVC — doit rester cohérent avec manchons/solins
  },
  ANCESTRAL: {
    pontage_materiau: champSourceSchema(), // contreplaqué | planche (bois seulement)
    // 8 items candidats (baguettes, tôle canadienne, joints debout, ardoise,
    // lucarnes, gouttières, ornements, solins) — un projet réel n'en utilise
    // généralement que 2-4. present=false ⇒ le filler SUPPRIME le paragraphe
    // entier plutôt que de le laisser en placeholder.
    items_toiture_metallique: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['baguettes', 'tole_canadienne', 'joints_debout', 'ardoise', 'lucarnes', 'gouttieres', 'ornements', 'solins'] },
          present: { type: 'boolean' },
          metal_ou_materiau: { type: 'string' },
          dimension_ou_quantite: { type: 'string' },
          valeur: { type: 'string' },
          statut: { type: 'string', enum: ['confirme', 'a_verifier', 'contradictoire', 'non_trouve'] },
          document_source: { type: 'string' },
          page_source: { type: 'string' },
          extrait_source: { type: 'string' },
          niveau_confiance: { type: 'string', enum: ['eleve', 'moyen', 'faible'] },
        },
        required: ['type', 'present', 'metal_ou_materiau', 'dimension_ou_quantite', 'valeur', 'statut', 'document_source', 'page_source', 'extrait_source', 'niveau_confiance'],
        additionalProperties: false,
      },
    },
  },
};

function construireSchemaExtraction(systeme) {
  const proprietes = { ...champsCommuns(), ...(CHAMPS_PAR_SYSTEME[systeme] || {}) };
  return {
    type: 'object',
    properties: proprietes,
    required: Object.keys(proprietes),
    additionalProperties: false,
  };
}

const SYSTEM_SOUMISSION_PRIVEE = `Tu analyses les documents d'un projet PRIVÉ de réfection de toiture (appel d'offre du client, plans, addendas — PAS un appel d'offres public SEAO) pour Toitures Trois Étoiles Inc. (T3E), afin de remplir automatiquement une lettre de soumission.

Les documents te sont fournis avec des marqueurs "===== DOCUMENT: nom (catégorie) =====" et "--- page N ---". Les ADDENDAS priment sur l'appel d'offre et les plans en cas de contradiction (ils sont placés en premier dans le contexte). Pour CHAQUE champ, cite le document exact (document_source), la page si connue (page_source, chaîne vide sinon), et un court extrait littéral (extrait_source) qui justifie ta réponse.

=== CHAMPS CLÉS ===
- client_nom : l'entreprise/institution qui a ÉMIS l'appel d'offre (le DESTINATAIRE de la lettre de soumission — à qui elle s'adresse) — PAS un entrepreneur général, un architecte ou un sous-traitant mentionné en passant dans les documents.
- numero_reference_projet : le numéro de projet/soumission/appel d'offre TEL QU'INDIQUÉ dans les documents eux-mêmes (page de garde, en-tête, nom de fichier répété dans le texte — ex: "25-190-01"). Ne confonds jamais ceci avec un numéro que T3E génère en interne, qui n'existe pas dans les documents sources.

=== RÈGLES ABSOLUES ===
- statut="non_trouve" avec valeur="" si l'information n'apparaît dans AUCUN document — N'INVENTE JAMAIS une dimension, une épaisseur, une quantité, un prix ou une spécification absente des documents. C'est la règle la plus importante : mieux vaut un champ vide et signalé que rempli avec une valeur plausible mais non prouvée.
- Pour un choix "X / Y / Z" (plusieurs options séparées par des barres obliques dans un gabarit), la valeur retournée doit être le texte EXACT de la SEULE option retenue (ex: "acier", pas "bois / acier / béton / siporex") — jamais la phrase complète avec les options non retenues.
- statut="confirme" seulement si l'information est explicite et non ambiguë. statut="a_verifier" si elle est déduite/implicite. statut="contradictoire" si deux documents se contredisent (valeur doit alors contenir les deux, en précisant que l'addenda prime).
- niveau_confiance="faible" pour toute déduction plutôt qu'une mention explicite.
- Les plans sont parfois des dessins vectoriels/scannés avec peu de texte extractible — c'est normal, ne force pas une réponse à partir d'un plan illisible.
- Réponds en français québécois professionnel.`;

async function analyserProjetSoumissionPrivee(contexteDocuments, systeme) {
  if (!OPENAI_API_KEY) return { error: 'OPENAI_API_KEY manquante' };

  const schema = construireSchemaExtraction(systeme);
  const userContent = `SYSTÈME DE TOITURE CHOISI : ${systeme}

DOCUMENTS DU PROJET :
───────────────────────────────────────
${contexteDocuments}
───────────────────────────────────────

Retourne un JSON avec tous les champs demandés pour ce système.`;

  return callOpenAI(SYSTEM_SOUMISSION_PRIVEE, userContent, schema, true, 8000);
}

// Construit un schema d'extraction limite a une liste de cles (utilise pour
// l'analyse visuelle des plans : ne redemande QUE les champs que le texte
// n'a pas trouves, voir plan-vision.js). Reutilise les memes definitions de
// champs que construireSchemaExtraction — champCommuns/CHAMPS_PAR_SYSTEME
// restent l'unique source de verite pour la forme de chaque champ.
function construireSchemaPourChamps(systeme, cles) {
  const toutesProps = { ...champsCommuns(), ...(CHAMPS_PAR_SYSTEME[systeme] || {}) };
  const proprietes = {};
  cles.forEach((c) => { if (toutesProps[c]) proprietes[c] = toutesProps[c]; });
  return { type: 'object', properties: proprietes, required: Object.keys(proprietes), additionalProperties: false };
}

const SYSTEM_VISION_PLANS = `Tu analyses des IMAGES de pages de plans/dessins d'un projet de réfection de toiture pour Toitures Trois Étoiles Inc. (T3E). Le texte des autres documents (appel d'offre, devis, addendas) n'a pas permis de trouver certains champs — tu dois chercher UNIQUEMENT ces champs sur les plans fournis (légendes, tableaux, notes, cotes, cartouche).

Chaque image correspond à un document et un numéro de page précisés dans le message (dans l'ordre des images).

=== RÈGLES ABSOLUES ===
- statut="non_trouve" avec valeur="" si l'information n'est visible sur AUCUNE des images fournies — N'INVENTE JAMAIS une dimension, une superficie ou une quantité.
- document_source = nom exact du fichier de plan indiqué pour l'image concernée.
- page_source = le numéro de page indiqué pour cette image.
- extrait_source = brève description de ce qui est visible sur l'image qui justifie la valeur (ex: "tableau de superficie totale en bas à droite de la page 2"), PAS une citation de texte.
- niveau_confiance="faible" si le plan est difficile à lire, une cote est partiellement masquée, ou l'information est déduite d'un dessin plutôt que lue directement.
- Réponds en français québécois professionnel.`;

// images: [{ page, base64, nomFichier }] (voir plan-vision.js). cles: noms
// des champs a chercher (deja filtres a ceux non_trouve par le texte).
async function analyserPlansVision(images, systeme, cles) {
  if (!OPENAI_API_KEY) return { error: 'OPENAI_API_KEY manquante' };
  if (!cles.length || !images.length) return {};

  const schema = construireSchemaPourChamps(systeme, cles);
  if (Object.keys(schema.properties).length === 0) return {};

  const contentBlocks = [
    {
      type: 'text',
      text: `CHAMPS À CHERCHER SUR CES PLANS : ${cles.join(', ')}\n\nIMAGES FOURNIES (dans l'ordre) :\n` +
        images.map((img, i) => `${i + 1}. ${img.nomFichier}, page ${img.page}`).join('\n'),
    },
    ...images.map((img) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${img.base64}`, detail: 'high' } })),
  ];

  return callOpenAI(SYSTEM_VISION_PLANS, contentBlocks, schema, true, 4000);
}

module.exports = {
  analyserDevis, analyserDevisSoumission, analyserDevisManuel,
  extraireFournisseursDesFT, mapperChampsBordereau,
  analyserInfosEntreprise, mapperChampsFormulairePdf,
  analyserExigencesAppelOffre,
  analyserProjetSoumissionPrivee,
  analyserPlansVision,
  isConfigured,
};
