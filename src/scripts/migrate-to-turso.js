const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

const LOCAL_DB = path.join(__dirname, '..', '..', 'data', 't3e.db');

async function migrate() {
  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
    console.error('ERREUR: Definir TURSO_DATABASE_URL et TURSO_AUTH_TOKEN');
    console.error('Exemple:');
    console.error('  $env:TURSO_DATABASE_URL = "libsql://ton-db.turso.io"');
    console.error('  $env:TURSO_AUTH_TOKEN = "ton-token"');
    process.exit(1);
  }

  if (!fs.existsSync(LOCAL_DB)) {
    console.error(`ERREUR: Base locale introuvable: ${LOCAL_DB}`);
    process.exit(1);
  }

  console.log('=== Migration locale -> Turso ===\n');

  const SQL = await initSqlJs();
  const buffer = fs.readFileSync(LOCAL_DB);
  const local = new SQL.Database(buffer);

  const turso = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  const tableNames = [
    'categories', 'architectes', 'projets',
    'documents', 'materiaux',
    'bordereaux', 'projet_documents',
    'historique_bordereaux',
  ];
  console.log(`Tables trouvees: ${tableNames.join(', ')}\n`);

  // Recreer le schema
  console.log('1. Creation du schema sur Turso...');
  const schemaDump = local.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  if (schemaDump.length > 0) {
    for (const row of schemaDump[0].values) {
      const createSql = row[0];
      if (createSql) {
        const safeSql = createSql.replace(/CREATE TABLE /i, 'CREATE TABLE IF NOT EXISTS ');
        await turso.execute(safeSql);
      }
    }
  }

  const indexDump = local.exec("SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL");
  if (indexDump.length > 0) {
    for (const row of indexDump[0].values) {
      const indexSql = row[0];
      if (indexSql) {
        const safeIdx = indexSql.replace(/CREATE INDEX /i, 'CREATE INDEX IF NOT EXISTS ');
        await turso.execute(safeIdx);
      }
    }
  }
  console.log('   Schema cree.\n');

  // Desactiver les contraintes de cle etrangere
  console.log('2. Migration des donnees...');
  await turso.execute('PRAGMA foreign_keys = OFF');
  let totalRows = 0;

  for (const table of tableNames) {
    const data = local.exec(`SELECT * FROM ${table}`);
    if (data.length === 0 || data[0].values.length === 0) {
      console.log(`   [${table}] 0 lignes (vide)`);
      continue;
    }

    const columns = data[0].columns;
    const rows = data[0].values;
    const placeholders = columns.map(() => '?').join(', ');
    const insertSql = `INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;

    let count = 0;
    for (const row of rows) {
      await turso.execute({
        sql: insertSql,
        args: row.map(v => v === null ? null : v),
      });
      count++;
    }

    console.log(`   [${table}] ${count} lignes migrees`);
    totalRows += count;
  }

  await turso.execute('PRAGMA foreign_keys = ON');

  console.log(`\n=== Migration terminee: ${totalRows} lignes au total ===`);

  local.close();
  turso.close();
}

migrate().catch(err => {
  console.error('Erreur de migration:', err);
  process.exit(1);
});
