const express = require('express');
const router = express.Router();

router.get('/', async (req, res) => {
  const db = req.db;
  const filtre = req.query.statut || '';

  let sql = `SELECT id, numero_projet, titre, statut, cree_par, modifie_par, approuve_par, created_at, updated_at
             FROM bordereaux`;
  const args = [];
  if (filtre) {
    sql += ` WHERE statut = ?`;
    args.push(filtre);
  }
  sql += ' ORDER BY updated_at DESC';

  const r = await db.execute({ sql, args });
  const bordereaux = r.rows;

  const counts = {};
  for (const s of ['brouillon', 'revise', 'approuve']) {
    const c = await db.execute({ sql: `SELECT COUNT(*) as c FROM bordereaux WHERE statut = ?`, args: [s] });
    counts[s] = c.rows[0].c;
  }

  res.render('approbation', { bordereaux, filtre, counts });
});

router.post('/changer-statut/:id', async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const { nouveau_statut, commentaire, effectue_par } = req.body;

  const current = await db.execute({ sql: `SELECT statut FROM bordereaux WHERE id = ?`, args: [id] });
  if (current.rows.length === 0) return res.redirect('/approbation');
  const ancien = current.rows[0].statut;

  const transitions = { brouillon: 'revise', revise: 'approuve' };
  if (transitions[ancien] !== nouveau_statut && nouveau_statut !== 'brouillon') {
    return res.redirect(`/approbation?error=invalid_transition`);
  }

  let updateSql = `UPDATE bordereaux SET statut = ?, updated_at = datetime('now')`;
  const updateArgs = [nouveau_statut];

  if (nouveau_statut === 'revise') {
    updateSql += `, modifie_par = ?`;
    updateArgs.push(effectue_par || 'Utilisateur');
  }
  if (nouveau_statut === 'approuve') {
    updateSql += `, approuve_par = ?`;
    updateArgs.push(effectue_par || 'Utilisateur');
  }

  updateSql += ` WHERE id = ?`;
  updateArgs.push(id);

  await db.execute({ sql: updateSql, args: updateArgs });

  await db.execute({
    sql: `INSERT INTO historique_bordereaux (bordereau_id, action, ancien_statut, nouveau_statut, commentaire, effectue_par)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [id, 'changement_statut', ancien, nouveau_statut, commentaire || null, effectue_par || 'Utilisateur']
  });

  res.redirect('/approbation');
});

module.exports = router;
