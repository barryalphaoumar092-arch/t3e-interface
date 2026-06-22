const { createClient } = require('@libsql/client');

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:./data/t3e.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function initDb() {
  const r = await db.execute('SELECT COUNT(*) as c FROM categories');
  console.log(`Base de donnees connectee (${r.rows[0].c} categories)`);
}

function getDb() {
  return db;
}

module.exports = { getDb, initDb, db };
