const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.render('recherche', { query: '', resultats: null });
});

module.exports = router;
