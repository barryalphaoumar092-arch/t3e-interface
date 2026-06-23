const express = require('express');
const router = express.Router();

router.get('/', async (req, res) => {
  const db = req.db;
  const docs = (await db.execute('SELECT COUNT(*) as c FROM documents')).rows[0].c;
  const mats = (await db.execute('SELECT COUNT(*) as c FROM materiaux')).rows[0].c;
  const ft = (await db.execute("SELECT COUNT(*) as c FROM materiaux WHERE lien_fiche_technique != '' AND lien_fiche_technique IS NOT NULL")).rows[0].c;
  const bord = (await db.execute('SELECT COUNT(*) as c FROM bordereaux')).rows[0].c;
  const arch = (await db.execute('SELECT COUNT(*) as c FROM architectes')).rows[0].c;

  let soum = 0;
  try { soum = (await db.execute('SELECT COUNT(*) as c FROM soumissions')).rows[0].c; } catch(e) {}

  res.render('accueil', {
    stats: { documents: docs, materiaux: mats, fichestechniques: ft, bordereaux: bord, architectes: arch, soumissions: soum }
  });
});

module.exports = router;
