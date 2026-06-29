const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = 'gpt-4o';
const API_URL = 'https://api.openai.com/v1/chat/completions';

async function callOpenAI(systemPrompt, userContent, jsonSchema, strictMode = true) {
  if (!OPENAI_API_KEY) {
    return { error: "OPENAI_API_KEY non configurée. Ajoutez-la dans les variables d'environnement Render." };
  }

  const body = {
    model: MODEL,
    max_tokens: 4096,
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
Tu remplis une SOUMISSION de toiture à partir d'un devis. Tu dois FOUILLER EN PROFONDEUR le devis pour extraire un MAXIMUM d'informations.
Lis CHAQUE LIGNE du devis attentivement. Prends ton temps, la qualité est plus importante que la vitesse.

La soumission T3E contient des choix séparés par "/" — tu dois CHOISIR la bonne option pour CHAQUE choix selon le devis.

=== RÈGLES ABSOLUES ===
1. Extrais les informations EXACTES du devis — ne les invente pas.
2. NE LAISSE JAMAIS un champ vide si l'information existe quelque part dans le devis.
3. Pour les quantités (drains, manchons, etc.) : si le devis dit "voir plans" ou ne donne pas de nombre explicite, retourne "les".
4. Si une info n'est PAS dans le devis, retourne une chaîne vide "".

=== CHAMPS À REMPLIR (cherche dans TOUT le texte du devis) ===

CLIENT :
- client_nom : Nom complet du client/propriétaire (cherche "Propriétaire", "Client", "Maître de l'ouvrage")
- client_adresse : Adresse complète du client
- client_ville, client_province (défaut "QC"), client_code_postal
- client_contact : Nom du représentant/contact (cherche "Attention", "Contact", "Représentant")
- client_telephone : Numéro de téléphone (cherche "Tél", "Cellulaire", "Phone")
- client_courriel : Adresse email

PROJET :
- projet_nom : Nom complet du projet tel qu'écrit dans le devis
- projet_adresse : Adresse du bâtiment/chantier
- systeme_toiture : EXACTEMENT une de : BUR, SOPRASMART, SOPRAFIX, COLVENT, EPDM_PVC, TPO_PVC_RHINOBOND, INVERSE, ANCESTRAL
  Indices : "asphalte et gravier" = BUR, "panneau laminé" / "Soprasmart" = SOPRASMART, "fixation mécanique" / "Soprafix" = SOPRAFIX, "membrane élastomère SBS adhérée" peut être BUR ou SOPRASMART selon le contexte
- type_travaux : REFECTION ou PLEUMAGE
- superficie_pc : en pieds carrés (cherche "pieds carrés", "pi²", "p.c.", "sq ft")
- superficie_m2 : en m² si disponible

TECHNIQUE — CHOISIS pour chaque "/" :
- pontage : UN SEUL parmi "acier", "bois", "béton", "siporex" (cherche "pontage de/d'")
- methode_adhesion : UN SEUL parmi "adhésif", "asphalte", "mécanique", "thermosoudé"
- type_pare_vapeur : Le texte EXACT du choix retenu. Ex: "2 plis de feutre #15 adhéré à l'asphalte" ou "un pare-vapeur thermosoudé SOPRALENE 180 SP 3,5 (Soprema)"
- type_isolant : "polyisocyanurate" ou "polystyrène"
- epaisseur_isolant : en pouces, ex "3½". Convertis RSI si nécessaire (RSI 5.46 ≈ 3½")
- pente_isolant : "1%" ou "2%"
- type_fibre : "fibre de bois" ou "perlite" (pour BUR)
- epaisseur_fibre_bois : épaisseur en pouces, ex "½"
- nb_plis : "4" ou "5" (pour BUR)
- type_membrane_finition : description du choix retenu
- couleur_membrane : "blanche", "grise", etc.
- type_gravier : le choix retenu pour BUR ("standard 450 lbs" ou "réfléchissantes blanches 650 lbs")
- type_releves : le texte du choix retenu pour les relevés
- materiau_solins : "acier prépeint", "acier galvanisé" ou "cuivre 16oz"
- calibre_solins : "24" ou "26"
- type_solins : description complète (ex "Weather XL (Vicwest)")
- cols_cygne_type : "existants" ou "Ventilateur Maximum"
- ventilateur_max : numéro de modèle si applicable

QUANTITÉS :
- nb_drains, nb_drains_urgence, nb_manchons_events, nb_manchons_etancheite, nb_cols_cygne

FINANCIER :
- cout_remplacement_cp : prix $/pi² contreplaqué (ex "8.50")
- cout_remplacement_isolant : prix $/pi² isolant
- garantie_t3e : "5 ans", "10 ans", "15 ans" ou "20 ans"
- garantie_manufacturier : "10 ans", "15 ans", "20 ans" ou "25 ans"

DOCUMENTS :
- documents_recus, date_documents, sections_devis, addenda
- bassins : liste des bassins concernés

AUTRES :
- type_panneau_support, type_drain, rsi_minimum
- notes : observations importantes
- confiance : "haute", "moyenne" ou "basse"`;

  const userContent = `TEXTE COMPLET DU DEVIS (lis CHAQUE ligne attentivement) :
───────────────────────────────────────
${texteDevis}
───────────────────────────────────────

Analyse ce devis en profondeur et retourne un JSON avec TOUS les champs remplis au maximum.
IMPORTANT : Pour chaque choix "/" dans le template, CHOISIS la bonne option selon le contexte du devis.
Ne laisse AUCUN champ vide si l'information existe dans le devis.`;

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

function isConfigured() {
  return !!OPENAI_API_KEY;
}

module.exports = { analyserDevis, analyserDevisSoumission, isConfigured };
