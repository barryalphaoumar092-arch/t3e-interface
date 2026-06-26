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

// OpenAI strict mode exige que TOUS les champs soient dans "required"
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

// Pour les suggestions de bordereau, les clés sont dynamiques → json_object (non-strict)
async function proposerContenuBordereau(champs, projet, texteDevis, materiauxDB) {
  const champsListe = (champs || []).map(c => `- Clé: "${c.key}" | Label: "${c.label}"`).join('\n');

  const userContent = `Tu dois remplir TOUS les champs d'un bordereau technique de transmission de matériaux pour Toitures Trois Étoiles Inc. (T3E), couvreur commercial au Québec.

CHAMPS DU BORDEREAU (remplis CHACUN sans exception) :
${champsListe || '- nom | NOM entrepreneur\n- sp_cialit | SPÉCIALITÉ\n- nom_du_projet | NOM DU PROJET\n- adresse | ADRESSE\n- titre | Titre\n- description | Description\n- fournisseur | Fournisseur\n- fabricant | Fabricant\n- d_lai | Délai\n- remarque | Remarque'}

INFORMATIONS DU PROJET (déjà extraites) :
${Object.entries(projet || {}).filter(([,v]) => v).map(([k,v]) => `- ${k}: ${v}`).join('\n') || 'Aucune information de projet enregistrée'}

DEVIS DU PROJET (extrais : client, adresse, matériaux, type de travaux, description du projet) :
${texteDevis ? texteDevis.substring(0, 3500) : 'Aucun devis fourni — utilise les informations disponibles'}

MATÉRIAUX DISPONIBLES EN BASE :
${(materiauxDB || []).slice(0, 40).map(m => `- ${m.nom} (${m.fabricant})`).join('\n')}

RÈGLES OBLIGATOIRES — respecte-les sans exception :
1. Champ "nom" → TOUJOURS "Toitures Trois Étoiles Inc."
2. Champ "sp_cialit" → TOUJOURS "Couvreur"
3. Champ "nombre_feuilles" → "1" si non précisé
4. Champ "r_vision" → "A" si non précisé
5. Champ "d_lai" → "3 à 4 semaines" si non précisé
6. Remplis TOUS les champs — ne laisse RIEN vide
7. Si le devis mentionne des matériaux spécifiques, utilise-les pour "fournisseur", "fabricant", "description"
8. Pour "nom_du_projet" et "adresse", utilise les infos du projet ou du devis

Retourne un JSON avec la clé "suggestions" : objet où chaque clé correspond EXACTEMENT à une clé de la liste ci-dessus, et la valeur est un tableau avec la meilleure valeur en premier élément.
Format strict : { "suggestions": { "nom": ["Toitures Trois Étoiles Inc."], "sp_cialit": ["Couvreur"], "nom_du_projet": ["École ABC — Réfection toiture"], "fournisseur": ["Soprema"], ... } }`;

  return callOpenAI(SYSTEM_T3E, userContent, {}, false);
}

// Remplissage complet du bordereau : champs + fiches recommandées — tout en une seule IA
async function proposerContenuBordereauComplet(champs, projet, texteDevis, materiauxDB, fichesDispo) {
  const champsListe = (champs || []).map(c => `- Clé: "${c.key}" | Label: "${c.label}"`).join('\n');
  const fichesListe = (fichesDispo || []).slice(0, 80).map(f => `- ID ${f.id}: ${f.titre} (${f.source || ''})`).join('\n');

  const userContent = `Tu remplis un bordereau technique de transmission de matériaux pour Toitures Trois Étoiles Inc. (T3E), couvreur commercial au Québec. Tu es expert en toiture — remplis comme si tu connaissais ce projet parfaitement.

CHAMPS DU BORDEREAU À REMPLIR (tous obligatoires) :
${champsListe || '- nom | NOM entrepreneur\n- sp_cialit | SPÉCIALITÉ\n- nom_du_projet | NOM DU PROJET\n- adresse | ADRESSE\n- titre | Titre\n- description | Description\n- fournisseur | Fournisseur\n- fabricant | Fabricant\n- d_lai | Délai\n- remarque | Remarque'}

INFORMATIONS DU PROJET :
${Object.entries(projet || {}).filter(([,v]) => v).map(([k,v]) => `- ${k}: ${v}`).join('\n') || 'À extraire du devis'}

DEVIS DU PROJET (extrait matériaux, fabricants, spécifications, systèmes, quantités, notes) :
${texteDevis ? texteDevis.substring(0, 4000) : 'Aucun devis — utilise tes connaissances pour un projet T3E typique'}

MATÉRIAUX EN BASE DE CONNAISSANCES :
${(materiauxDB || []).slice(0, 60).map(m => `- ${m.nom} (${m.fabricant}${m.type_produit ? ', ' + m.type_produit : ''})`).join('\n')}

FICHES TECHNIQUES DISPONIBLES :
${fichesListe || 'Aucune fiche disponible'}

RÈGLES FIXES (ne jamais déroger) :
1. "nom" → "Toitures Trois Étoiles Inc."
2. "sp_cialit" → "Couvreur"
3. "nombre_feuilles" → "1"
4. "r_vision" → "A"
5. "d_lai" → "3 à 4 semaines" si non précisé dans le devis
6. Remplis TOUS les champs — jamais de chaîne vide
7. "fiches_recommandees" → 2 à 6 IDs des fiches les plus pertinentes pour les matériaux de ce projet

Retourne UNIQUEMENT ce JSON :
{
  "suggestions": { "nom": ["Toitures Trois Étoiles Inc."], "sp_cialit": ["Couvreur"], "nom_du_projet": ["..."], "fournisseur": ["..."], "fabricant": ["..."], "description": ["..."], ... },
  "fiches_recommandees": [12, 45, 67]
}`;

  return callOpenAI(SYSTEM_T3E, userContent, {}, false);
}

function isConfigured() {
  return !!OPENAI_API_KEY;
}

// Alias pour compatibilité avec tout code qui importerait callClaude
const callClaude = callOpenAI;

module.exports = { analyserDevis, proposerContenuBordereau, proposerContenuBordereauComplet, isConfigured, callClaude };
