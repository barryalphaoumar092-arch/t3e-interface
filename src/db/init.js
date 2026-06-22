const { createTursoClient } = require('./turso-client');

const url = (process.env.TURSO_DATABASE_URL || '').trim().replace(/^["']|["']$/g, '');
const authToken = (process.env.TURSO_AUTH_TOKEN || '').trim().replace(/^["']|["']$/g, '');

let db;

if (url && url.startsWith('libsql://')) {
  db = createTursoClient(url, authToken);
  console.log('Mode: Turso cloud');
} else {
  const { createClient } = require('@libsql/client');
  db = createClient({ url: url || 'file:./data/t3e.db', authToken });
  console.log('Mode: Local SQLite');
}

async function initDb() {
  const r = await db.execute('SELECT COUNT(*) as c FROM categories');
  console.log(`Base de donnees connectee (${r.rows[0].c} categories)`);
}

function getDb() {
  return db;
}

module.exports = { getDb, initDb, db };
