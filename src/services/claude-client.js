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

const ANALYSE_SOUMISSION_SCHEMA = {
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
    systeme_toiture:              { type: 'string' },
    type_travaux:                 { type: 'string' },
    superficie_pc:                { type: 'string' },
    superficie_m2:                { type: 'string' },
    pontage:                      { type: 'string' },
    epaisseur_isolant:            { type: 'string' },
    pente_isolant:                { type: 'string' },
    type_isolant:                 { type: 'string' },
    type_pare_vapeur:             { type: 'string' },
    type_membrane_finition:       { type: 'string' },
    couleur_membrane:             { type: 'string' },
    type_panneau_support:         { type: 'string' },
    nb_drains:                    { type: 'string' },
    nb_drains_urgence:            { type: 'string' },
    nb_manchons_events:           { type: 'string' },
    nb_manchons_etancheite:       { type: 'string' },
    nb_cols_cygne:                { type: 'string' },
    type_solins:                  { type: 'string' },
    calibre_solins:               { type: 'string' },
    type_drain:                   { type: 'string' },
    bassins:                      { type: 'string' },
    garantie_t3e:                 { type: 'string' },
    garantie_manufacturier:       { type: 'string' },
    cout_remplacement_cp:         { type: 'string' },
    cout_remplacement_isolant:    { type: 'string' },
    documents_recus:              { type: 'string' },
    date_documents:               { type: 'string' },
    sections_devis:               { type: 'string' },
    addenda:                      { type: 'string' },
    rsi_minimum:                  { type: 'string' },
    type_releves:                 { type: 'string' },
    methode_adhesion:             { type: 'string' },
    type_gravier:                 { type: 'string' },
    nb_plis:                      { type: 'string' },
    epaisseur_fibre_bois:         { type: 'string' },
    type_fibre:                   { type: 'string' },
    materiau_solins:              { type: 'string' },
    ventilateur_max:              { type: 'string' },
    cols_cygne_type:              { type: 'string' },
    notes:                        { type: 'string' },
    confiance:                    { type: 'string' },
  },
  required: [
    'client_nom', 'client_adresse', 'client_ville', 'client_province', 'client_code_postal',
    'client_contact', 'client_telephone', 'client_courriel',
    'projet_nom', 'projet_adresse', 'systeme_toiture', 'type_travaux',
    'superficie_pc', 'superficie_m2', 'pontage', 'epaisseur_isolant', 'pente_isolant',
    'type_isolant', 'type_pare_vapeur', 'type_membrane_finition', 'couleur_membrane',
    'type_panneau_support', 'nb_drains', 'nb_drains_urgence',
    'nb_manchons_events', 'nb_manchons_etancheite', 'nb_cols_cygne',
    'type_solins', 'calibre_solins', 'type_drain', 'bassins',
    'garantie_t3e', 'garantie_manufacturier', 'cout_remplacement_cp', 'cout_remplacement_isolant',
    'documents_recus', 'date_documents', 'sections_devis', 'addenda',
    'rsi_minimum', 'type_releves', 'methode_adhesion', 'type_gravier',
    'nb_plis', 'epaisseur_fibre_bois', 'type_fibre', 'materiau_solins',
    'ventilateur_max', 'cols_cygne_type', 'notes', 'confiance',
  ],
  additionalProperties: false,
};

async function analyserDevisSoumission(texteDevis) {
  const systemPrompt = `Tu es un expert en toitures commerciales au Québec pour Toitures Trois Étoiles Inc. (T3E).
Tu dois extraire TOUTES les informations du devis pour remplir une soumission T3E. Sois EXHAUSTIF et PRÉCIS.
La soumission T3E contient des choix séparés par "/" — tu dois CHOISIR la bonne option pour CHAQUE choix.

=== RÈGLES ABSOLUES ===
1. Extrais les informations EXACTES du devis — ne les invente pas.
2. CHAQUE champ doit avoir une valeur si le devis contient l'information. NE LAISSE AUCUN CHAMP VIDE si l'info existe.
3. Si le devis ne donne pas un nombre exact (dit "voir plans"), retourne "les" pour les quantités.
4. Si une info n'est PAS dans le devis, retourne "".
5. Pour confiance : "haute", "moyenne", ou "basse".

=== CHOIX TECHNIQUES À RÉSOUDRE (les templates T3E ont des "/" entre options) ===

PONTAGE — Retourne UN SEUL parmi : "acier", "bois", "béton", "siporex"
  Le devis dit généralement "pontage d'acier" ou "pontage de bois" etc.

MÉTHODE D'ADHÉSION (methode_adhesion) — Retourne UN SEUL parmi :
  "adhésif" | "asphalte" | "mécanique" | "thermosoudé"
  Exemples dans le devis : "adhéré à l'adhésif", "adhéré avec de l'asphalte chaud", "fixé mécaniquement", "thermosoudé"

PARE-VAPEUR (type_pare_vapeur) — Retourne le texte EXACT du choix, ex :
  "un pare-vapeur de papier kraft adhéré à l'adhésif" (BUR)
  "un pare-vapeur élastomère thermosoudée sur surface préalablement apprêtée" (élastomère)
  "2 plis de feutre #15 adhéré à l'asphalte" (BUR multicouche)
  "un pare-vapeur thermosoudé SOPRALENE 180 SP 3,5 (Soprema) installé à l'adhésif" (SOPRASMART)

ISOLANT — Retourne type et épaisseur :
  type_isolant : "polyisocyanurate" | "polystyrène" | "fibre de bois" | "perlite"
  epaisseur_isolant : en pouces, ex "3½" ou "2". Convertis RSI si nécessaire (RSI 5.46 ≈ 3½")
  pente_isolant : "1%" ou "2%" (le devis spécifie la pente)

FIBRE DE BOIS / PERLITE (pour BUR) :
  type_fibre : "fibre de bois" | "perlite"
  epaisseur_fibre_bois : épaisseur en pouces, ex "½" ou "¾"

NOMBRE DE PLIS (nb_plis, pour BUR) : "4" ou "5"

MEMBRANE FINITION :
  BUR : "asphalte type 2 et du gravier" | "membranes élastomères"
  SOPRASMART : "membrane de finition élastomère granulée de couleur réfléchissante blanche"

GRAVIER (type_gravier, pour BUR) :
  "gravier ¼'' standard environ 450 lbs. / 100 pieds carrés"
  OU "gravier ¼'' réfléchissantes blanches environ 650 lbs. / 100 pieds carrés"

RELEVÉS (type_releves) — Retourne le texte choisi :
  BUR : "papier feutre #15, coton saturé et de l'asphalte chaud" | "deux (2) plis de membranes élastomères fini sablé adhérées à l'asphalte chaud"
  SOPRASMART : "contreplaqué ½''" | "asphaltique ½''"

SOLINS :
  materiau_solins : "acier prépeint" | "acier galvanisé" | "cuivre 16oz"
  calibre_solins : "26" | "24"
  type_solins : description (ex "Weather XL (Vicwest)")

COLS DE CYGNE :
  cols_cygne_type : "existants" | "Ventilateur Maximum"
  ventilateur_max : numéro de modèle si Ventilateur Maximum, sinon ""

COÛTS REMPLACEMENT :
  cout_remplacement_cp : prix $/pi² pour contreplaqué (ex "8.50"), si dans le devis
  cout_remplacement_isolant : prix $/pi² pour isolant, si dans le devis

GARANTIES :
  garantie_t3e : "5 ans", "10 ans", "15 ans" ou "20 ans"
  garantie_manufacturier : "10 ans", "15 ans", "20 ans" ou "25 ans"

SYSTÈME DE TOITURE : EXACTEMENT une de ces valeurs :
  BUR | SOPRASMART | SOPRAFIX | COLVENT | EPDM_PVC | TPO_PVC_RHINOBOND | INVERSE | ANCESTRAL

TYPE TRAVAUX : REFECTION | PLEUMAGE`;

  const userContent = `Analyse ce devis de toiture et extrais TOUTES les informations.
IMPORTANT : Résous CHAQUE choix "/" en choisissant la bonne option selon le contexte du devis.
Remplis TOUS les champs — ne laisse rien vide si l'information existe dans le devis.

TEXTE DU DEVIS :
${texteDevis}`;

  return callOpenAI(systemPrompt, userContent, ANALYSE_SOUMISSION_SCHEMA, true);
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
