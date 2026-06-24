const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { getDb, initDb } = require('./src/db/init');

const app = express();
const PORT = process.env.PORT || 3000;
const MOT_DE_PASSE = process.env.MDP_APP || 'barry';
const sessions = new Set();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/login', (req, res) => {
  const erreur = req.query.erreur === '1';
  res.render('login', { erreur });
});

app.post('/login', (req, res) => {
  if (req.body.mot_de_passe === MOT_DE_PASSE) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.add(token);
    res.cookie('t3e_session', token, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
    res.redirect('/');
  } else {
    res.redirect('/login?erreur=1');
  }
});

app.get('/logout', (req, res) => {
  const token = parseCookie(req.headers.cookie || '')['t3e_session'];
  if (token) sessions.delete(token);
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
  if (cookies.t3e_session && sessions.has(cookies.t3e_session)) return next();
  res.redirect('/login');
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/documents', express.static(path.join(__dirname, 'documents')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use((req, res, next) => {
  req.db = getDb();
  next();
});

app.use('/', require('./src/routes/index'));
app.use('/connaissances', require('./src/routes/connaissances'));
app.use('/bordereaux', require('./src/routes/bordereaux'));
app.use('/soumissions', require('./src/routes/soumissions'));
app.use('/approbation', require('./src/routes/approbation'));
app.use('/recherche', require('./src/routes/recherche'));
app.use('/api', require('./src/routes/api'));

app.use((err, req, res, next) => {
  console.error('ERREUR SERVEUR:', err.stack || err.message || err);
  res.status(500).send(`<h2>Erreur serveur</h2><pre>${err.message || err}</pre><a href="/">Retour</a>`);
});

async function start() {
  try {
    const fs = require('fs');
    const dirs = ['uploads', 'uploads/soumissions', 'data'];
    for (const d of dirs) {
      const p = path.join(__dirname, d);
      if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    }

    await initDb();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`\n  Interface T3E demarree:`);
      console.log(`    Local:  http://localhost:${PORT}`);
      if (!process.env.TURSO_DATABASE_URL) {
        console.log(`    Mode:   Local (SQLite fichier)`);
      } else {
        console.log(`    Mode:   Cloud (Turso)`);
      }
      console.log();
    });
  } catch (err) {
    console.error('Erreur au demarrage:', err);
    process.exit(1);
  }
}

start();
