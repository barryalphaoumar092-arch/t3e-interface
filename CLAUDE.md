# T3E Interface — Contexte pour Claude

## Le projet
Interface web interne pour **Toitures Trois Étoiles Inc.** (T3E), entreprise de couverture commerciale au Québec. Le site automatise la création de **soumissions** (devis de prix) et **bordereaux techniques** (feuilles de transmission de matériaux).

## Stack
- **Backend** : Node.js 22 / Express 5 / EJS
- **Base de données** : Turso (cloud SQLite) via client HTTP custom (`src/db/turso-client.js` → API `/v2/pipeline`)
- **PDF** : PDF.js (preview navigateur), pdf-lib (overlay texte sur PDF), pdfkit (conversion Word→PDF)
- **Word** : JSZip (manipulation .docx XML), mammoth/word-extractor (extraction texte)
- **Hébergement** : Render.com (free tier, auto-deploy depuis GitHub)
- **Langue** : L'interface et les communications sont en **français**

## Accès
- **Site** : https://t3e-interface.onrender.com (mot de passe : `barry`)
- **GitHub** : github.com/barryalphaoumar092-arch/t3e-interface
- **Turso** : `libsql://t3e-barryalphaoumar092-arch.aws-us-east-1.turso.io`

## Architecture des fichiers

```
server.js                          # Express app, auth cookie, routes
src/
  db/
    init.js                        # Connexion Turso + migrations
    turso-client.js                # Client HTTP custom pour Turso /v2/pipeline
    schema.js                      # Schéma SQL (tables: categories, documents, materiaux, architectes, bordereaux, soumissions)
  routes/
    index.js                       # Page d'accueil (dashboard)
    connaissances.js               # CRUD documents, matériaux, architectes
    bordereaux.js                  # Upload template PDF → éditeur drag-and-drop → PDF final
    soumissions.js                 # Formulaire → remplissage template Word → .docx
    approbation.js                 # Workflow validation bordereaux
    recherche.js                   # Page recherche
    api.js                         # API JSON (recherche fulltext)
  services/
    soumission-generator.js        # Remplit les templates Word .docx (XML manipulation via JSZip)
    pdf-filler.js                  # Overlay texte sur PDF template (pdf-lib)
    document-parser.js             # Parse PDF/Excel/Word (extraction texte)
    material-matcher.js            # Matching matériaux (Jaccard + scoring)
    claude-client.js               # Client API Claude (à activer avec ANTHROPIC_API_KEY)
views/
    *.ejs                          # Templates EJS (Bootstrap 5)
documents/
    FT/                            # 121 fiches techniques PDF (Soprema, IKO, BP, etc.)
    templates-soumission/          # 18 templates Word FR+EN (BUR, SOPRASMART, SOPRAFIX, etc.)
```

## Modules

### Soumissions
- L'utilisateur choisit un système de toiture + type de travaux → le site sélectionne le bon template Word parmi 18
- Le template est rempli en remplaçant les placeholders dans le XML du .docx
- Templates dans `documents/templates-soumission/` : BUR, SOPRASMART, SOPRAFIX, COLVENT, EPDM/PVC, TPO/PVC, INVERSE, ANCESTRAL × (FR + EN) × (REFECTION + PLEUMAGE)
- Les remplacements gèrent : headers Word (header1-6.xml), apostrophes courbes (U+2019), espaces insécables (U+00A0), runs XML splittés

### Bordereaux
- L'utilisateur uploade un bordereau PDF vierge → stocké en base64 dans la DB
- Éditeur split-screen : gauche = dropdowns avec suggestions, droite = PDF.js canvas avec overlays draggables
- Positions stockées en % → converties en coordonnées PDF par pdf-filler.js
- Les fiches techniques sélectionnées sont appendues au PDF final

### Base de connaissances
- 508 matériaux (nom, fabricant, type, dimensions, liens FT/SDS)
- Documents catégorisés (fiches techniques, devis, plans)
- Architectes (firme, contact, téléphone, email)

## Conventions
- `db.execute(sql, params)` : le turso-client accepte DEUX formes : `execute("SQL", [args])` ET `execute({sql, args})`
- Les fichiers uploadés vont dans `uploads/` (gitignored, créé au démarrage)
- Les templates soumission et FT sont dans le repo Git (pas éphémères)
- Le mot de passe du site est dans `process.env.MDP_APP` (défaut: `barry`)

## Variables d'environnement (Render)
```
TURSO_DATABASE_URL=libsql://t3e-barryalphaoumar092-arch.aws-us-east-1.turso.io
TURSO_AUTH_TOKEN=eyJhbGci...
MDP_APP=barry
NODE_ENV=production
ANTHROPIC_API_KEY=sk-ant-...  (à ajouter quand approuvé)
```

## Points d'attention
- Express 5 gère les erreurs async nativement (pas besoin de express-async-errors)
- Le filesystem Render est éphémère : ne pas stocker de fichiers permanents sur disque, utiliser la DB
- Les templates Word splitent le texte en multiple `<w:r>` runs — utiliser `replaceInXml()` ou `normalizeXmlText()` pour gérer
- Les apostrophes Word sont U+2019 (curly), pas U+0027 (straight) — utiliser `CURLY_APOS` constant
