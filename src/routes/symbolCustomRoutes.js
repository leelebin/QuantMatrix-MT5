const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  list,
  getById,
  getBySymbol,
  create,
  update,
  remove,
  duplicate,
} = require('../controllers/symbolCustomController');

router.use(protect);

router.get('/', list);
router.get('/by-symbol/:symbol', getBySymbol);
router.get('/:id', getById);
router.post('/', create);
router.put('/:id', update);
router.delete('/:id', remove);
router.post('/:id/duplicate', duplicate);

module.exports = router;
