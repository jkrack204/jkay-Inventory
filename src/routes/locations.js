const express = require('express');
const { supabaseAdmin } = require('../lib/supabase');

const router = express.Router();

// GET /api/locations — the (currently two) locations. Used for the admin
// homepage's two arrows and any location picker.
router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .schema('inventory')
      .from('locations')
      .select('id, name')
      .eq('is_active', true)
      .order('name');
    if (error) return res.status(400).json({ error: error.message });
    res.json({ locations: data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
