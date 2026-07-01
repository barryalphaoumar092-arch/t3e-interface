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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Endpoint public pour le keep-alive (avant le middleware d'auth)
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

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

app.use('/recherche', require('./src/routes/recherche'));
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
