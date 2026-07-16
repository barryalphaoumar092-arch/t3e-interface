require('./src/load-env');
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { getDb, initDb } = require('./src/db/init');

const app = express();
const PORT = process.env.PORT || 3000;
const MOT_DE_PASSE = process.env.MDP_APP || 'barry';
const SESSION_SECRET = process.env.SESSION_SECRET || MOT_DE_PASSE;
const SESSION_MAX_AGE = 24 * 60 * 60 * 1000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Cle anon Supabase : concue pour etre publique (elle ne donne aucun droit
// sans policy explicite), utilisee par le navigateur pour uploader les gros
// fichiers directement vers Supabase Storage (voir public/js/direct-upload.js).
app.locals.SUPABASE_URL = process.env.SUPABASE_URL || '';
app.locals.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNmdWxjZHp2dGN5bXF3bnVpdG1rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5MDEyMjEsImV4cCI6MjA5ODQ3NzIyMX0.bZkfLOVptBvuo3npjRRTOEN2AwLkVAJAmR2K9nS-UY8';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Endpoint public pour le keep-alive (avant le middleware d'auth)
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

// Endpoint interne (appelé serveur-à-serveur par docx-to-pdf.js) : convertit un
// .docx en PDF via LibreOffice, exécuté ici quand cette instance a soffice
// (Render) alors que l'appelant ne l'a pas (Vercel). Protégé par secret partagé
// car public sur Internet, avant le middleware d'auth car sans cookie de session.
app.post('/internal/convertir-docx-pdf', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  // .trim() car les dashboards d'env vars (Render/Vercel) ajoutent parfois un
  // espace ou saut de ligne invisible en fin de valeur lors du copier-coller.
  const secret = (process.env.CONVERT_SERVICE_SECRET || '').trim();
  const fourni = typeof req.headers['x-convert-secret'] === 'string'
    ? req.headers['x-convert-secret'].trim() : '';
  const valide = secret.length > 0 && fourni.length > 0
    && Buffer.byteLength(fourni) === Buffer.byteLength(secret)
    && crypto.timingSafeEqual(Buffer.from(fourni), Buffer.from(secret));
  if (!valide) {
    console.error(`[convert-auth] refuse — secret configure: ${secret.length} caracteres, recu: ${fourni.length} caracteres`);
    return res.status(403).send('Forbidden');
  }

  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).send('Corps .docx manquant');
  }
  try {
    const { convertirDocxEnPdfLocal } = require('./src/services/docx-to-pdf');
    const pdfBuf = await convertirDocxEnPdfLocal(req.body);
    res.type('application/pdf').send(pdfBuf);
  } catch (e) {
    res.status(500).send('Conversion échouée: ' + e.message);
  }
});

// Meme principe que /internal/convertir-docx-pdf : convertit un .doc legacy
// (Word 97-2003) en .docx via LibreOffice, pour les gabarits de bordereaux
// d'architectes encore envoyes dans l'ancien format binaire.
app.post('/internal/convertir-doc-docx', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  const secret = (process.env.CONVERT_SERVICE_SECRET || '').trim();
  const fourni = typeof req.headers['x-convert-secret'] === 'string'
    ? req.headers['x-convert-secret'].trim() : '';
  const valide = secret.length > 0 && fourni.length > 0
    && Buffer.byteLength(fourni) === Buffer.byteLength(secret)
    && crypto.timingSafeEqual(Buffer.from(fourni), Buffer.from(secret));
  if (!valide) {
    console.error(`[convert-auth] refuse — secret configure: ${secret.length} caracteres, recu: ${fourni.length} caracteres`);
    return res.status(403).send('Forbidden');
  }

  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).send('Corps .doc manquant');
  }
  try {
    const { convertirDocEnDocxLocal } = require('./src/services/doc-to-docx');
    const docxBuf = await convertirDocEnDocxLocal(req.body);
    res.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document').send(docxBuf);
  } catch (e) {
    res.status(500).send('Conversion échouée: ' + e.message);
  }
});

// Meme principe que /internal/convertir-docx-pdf, mais pour la GENERATION
// COMPLETE d'un manuel de fin de chantier (remplissage + fusion de tous les
// documents) — trop long pour tenir dans le plafond dur de 60s d'une fonction
// serverless Vercel (plan Hobby) des qu'il y a beaucoup de fiches techniques/
// dessins (signale par l'utilisateur : FUNCTION_INVOCATION_TIMEOUT avec 27
// FT). Repond immediatement (202) puis continue le traitement en
// arriere-plan : Render est un service persistant (pas une fonction a la
// demande), le code apres res.status(202) continue de s'executer normalement
// — contrairement a une fonction serverless qui gele apres la reponse.
// genererEtSauvegarderManuel() met a jour la base directement une fois
// termine (ou en cas d'echec), sans dependre d'une reponse HTTP attendue par
// quiconque.
app.post('/internal/generer-manuel', async (req, res) => {
  const secret = (process.env.CONVERT_SERVICE_SECRET || '').trim();
  const fourni = typeof req.headers['x-convert-secret'] === 'string'
    ? req.headers['x-convert-secret'].trim() : '';
  const valide = secret.length > 0 && fourni.length > 0
    && Buffer.byteLength(fourni) === Buffer.byteLength(secret)
    && crypto.timingSafeEqual(Buffer.from(fourni), Buffer.from(secret));
  if (!valide) {
    console.error(`[convert-auth] refuse — secret configure: ${secret.length} caracteres, recu: ${fourni.length} caracteres`);
    return res.status(403).send('Forbidden');
  }

  const manuelId = parseInt(req.body && req.body.manuelId);
  if (!manuelId) return res.status(400).json({ error: 'manuelId manquant' });

  res.status(202).json({ ok: true });

  try {
    await initDb();
    const db = getDb();
    const { genererEtSauvegarderManuel } = require('./src/services/manuel-generateur');
    const resultat = await genererEtSauvegarderManuel(db, manuelId);
    if (!resultat.ok) console.error('[internal/generer-manuel] echec pour', manuelId, ':', resultat.erreur);
  } catch (e) {
    console.error('[internal/generer-manuel] exception pour', manuelId, ':', e.message);
  }
});

// Même principe que /internal/generer-manuel, mais pour la génération
// complète des BORDEREAUX (N produits : téléchargement FT + remplissage .docx
// + conversion LibreOffice + fusion pdf-lib + ZIP) — la boucle séquentielle
// dépassait le plafond dur de 60 s des fonctions Vercel dès quelques produits
// (FUNCTION_INVOCATION_TIMEOUT signalé avec 8 produits). Répond 202 puis
// continue en arrière-plan ; genererEtSauvegarderBordereaux met à jour la DB
// et dépose le ZIP dans Supabase Storage (bucket bordereaux-generes).
app.post('/internal/generer-bordereaux', async (req, res) => {
  const secret = (process.env.CONVERT_SERVICE_SECRET || '').trim();
  const fourni = typeof req.headers['x-convert-secret'] === 'string'
    ? req.headers['x-convert-secret'].trim() : '';
  const valide = secret.length > 0 && fourni.length > 0
    && Buffer.byteLength(fourni) === Buffer.byteLength(secret)
    && crypto.timingSafeEqual(Buffer.from(fourni), Buffer.from(secret));
  if (!valide) {
    console.error(`[convert-auth] refuse — secret configure: ${secret.length} caracteres, recu: ${fourni.length} caracteres`);
    return res.status(403).send('Forbidden');
  }

  const bordereauId = parseInt(req.body && req.body.bordereauId);
  if (!bordereauId) return res.status(400).json({ error: 'bordereauId manquant' });

  res.status(202).json({ ok: true });

  try {
    await initDb();
    const db = getDb();
    const { genererEtSauvegarderBordereaux } = require('./src/routes/bordereaux');
    const resultat = await genererEtSauvegarderBordereaux(db, bordereauId);
    if (!resultat.ok) console.error('[internal/generer-bordereaux] echec pour', bordereauId, ':', resultat.erreur);
  } catch (e) {
    console.error('[internal/generer-bordereaux] exception pour', bordereauId, ':', e.message);
  }
});

// Analyse en arrière-plan des documents d'un projet « tel que construit » —
// même principe que /internal/generer-manuel : N documents à télécharger,
// parser et passer à l'IA dépassent facilement les 60 s de Vercel. Répond 202
// puis continue ; analyserProjetAsbuilt consigne tout dans la DB.
app.post('/internal/asbuilt-analyser', async (req, res) => {
  const secret = (process.env.CONVERT_SERVICE_SECRET || '').trim();
  const fourni = typeof req.headers['x-convert-secret'] === 'string'
    ? req.headers['x-convert-secret'].trim() : '';
  const valide = secret.length > 0 && fourni.length > 0
    && Buffer.byteLength(fourni) === Buffer.byteLength(secret)
    && crypto.timingSafeEqual(Buffer.from(fourni), Buffer.from(secret));
  if (!valide) return res.status(403).send('Forbidden');

  const projetId = parseInt(req.body && req.body.projetId);
  if (!projetId) return res.status(400).json({ error: 'projetId manquant' });

  res.status(202).json({ ok: true });

  try {
    await initDb();
    const db = getDb();
    const { analyserProjetAsbuilt } = require('./src/services/asbuilt-analyste');
    const resultat = await analyserProjetAsbuilt(db, projetId);
    if (!resultat.ok) console.error('[internal/asbuilt-analyser] echec pour', projetId, ':', resultat.erreur);
  } catch (e) {
    console.error('[internal/asbuilt-analyser] exception pour', projetId, ':', e.message);
  }
});

// Synchronisation hebdomadaire des appels d'offres SEAO (voir vercel.json,
// section "crons"). Vercel ajoute automatiquement l'en-tete
// "Authorization: Bearer $CRON_SECRET" sur les appels cron declenches par sa
// plateforme (convention officielle Vercel Cron Jobs) — a definir dans les
// variables d'environnement du projet. Place avant le middleware d'auth par
// cookie (l'appel cron n'a pas de session) ; initialise la DB soi-meme
// (le middleware partage qui pose req.db tourne plus bas, apres l'auth).
app.get('/api/cron/seao-sync', async (req, res) => {
  const secret = (process.env.CRON_SECRET || '').trim();
  const fourni = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  const valide = secret.length > 0 && fourni.length > 0
    && Buffer.byteLength(fourni) === Buffer.byteLength(secret)
    && crypto.timingSafeEqual(Buffer.from(fourni), Buffer.from(secret));
  if (!valide) return res.status(403).json({ error: 'Forbidden' });

  try {
    await initDb();
    const db = getDb();
    const { synchroniser } = require('./src/services/seao-sync');
    const resultat = await synchroniser(db);
    console.log('[seao-sync]', JSON.stringify(resultat));
    res.json({ ok: true, ...resultat });
  } catch (e) {
    console.error('[seao-sync] echec:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Session signee (HMAC), sans etat serveur — necessaire car les fonctions
// serverless (Vercel) ne partagent pas de memoire entre invocations/instances.
function signSession() {
  const exp = Date.now() + SESSION_MAX_AGE;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(String(exp)).digest('hex');
  return `${exp}.${sig}`;
}
function verifySession(token) {
  if (!token) return false;
  const [expStr, sig] = token.split('.');
  if (!expStr || !sig || !/^\d+$/.test(expStr)) return false;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(expStr).digest('hex');
  const sigBuf = Buffer.from(sig, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return false;
  return Number(expStr) > Date.now();
}

app.get('/login', (req, res) => {
  const erreur = req.query.erreur === '1';
  res.render('login', { erreur });
});

app.post('/login', (req, res) => {
  if (req.body.mot_de_passe === MOT_DE_PASSE) {
    res.cookie('t3e_session', signSession(), { httpOnly: true, maxAge: SESSION_MAX_AGE });
    res.redirect('/');
  } else {
    res.redirect('/login?erreur=1');
  }
});

app.get('/logout', (req, res) => {
  res.clearCookie('t3e_session');
  res.redirect('/login');
});

function parseCookie(str) {
  const obj = {};
  str.split(';').forEach(pair => {
    const [k, v] = pair.trim().split('=');
    if (k) obj[k] = decodeURIComponent(v || '');
  });
  return obj;
}

app.use((req, res, next) => {
  if (req.path === '/login') return next();
  const cookies = parseCookie(req.headers.cookie || '');
  if (verifySession(cookies.t3e_session)) return next();
  res.redirect('/login');
});

app.use(express.static(path.join(__dirname, 'public')));

// Initialisation DB paresseuse et mise en cache : sur serverless, chaque
// instance froide doit executer les migrations une seule fois avant de servir.
let dbInitPromise = null;
app.use((req, res, next) => {
  if (!dbInitPromise) dbInitPromise = initDb().catch(err => { dbInitPromise = null; throw err; });
  dbInitPromise.then(() => {
    req.db = getDb();
    next();
  }).catch(next);
});

app.use('/', require('./src/routes/index'));
app.use('/connaissances', require('./src/routes/connaissances'));
app.use('/bordereaux', require('./src/routes/bordereaux'));
app.use('/soumissions', require('./src/routes/soumissions'));
app.use('/manuels', require('./src/routes/manuels'));
app.use('/appels-offres', require('./src/routes/appels-offres'));

app.use('/recherche', require('./src/routes/recherche'));
app.use('/asbuilt', require('./src/routes/asbuilt'));
app.use('/api', require('./src/routes/api'));

app.use((err, req, res, next) => {
  console.error('ERREUR SERVEUR:', err.stack || err.message || err);
  const msg = String(err.message || err).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
  res.status(500).send(`<h2>Erreur serveur</h2><pre>${msg}</pre><a href="/">Retour</a>`);
});

// Ne demarre un serveur HTTP long-lived que hors environnement serverless
// (Vercel importe ce module via api/index.js sans jamais l'executer directement).
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  Interface T3E demarree:`);
    console.log(`    Local:  http://localhost:${PORT}`);
    if (!process.env.TURSO_DATABASE_URL) {
      console.log(`    Mode:   Local (SQLite fichier)`);
    } else {
      console.log(`    Mode:   Cloud (Turso)`);
    }
    console.log();

    // Auto-ping toutes les 14 min pour éviter le cold start Render free tier
    if (process.env.RENDER) {
      const siteUrl = process.env.RENDER_EXTERNAL_URL || 'https://t3e-interface.onrender.com';
      setInterval(() => {
        fetch(siteUrl + '/health').catch(() => {});
      }, 14 * 60 * 1000);
      console.log('  Keep-alive actif (ping /health toutes les 14 min)');
    }
  });
}

module.exports = app;
