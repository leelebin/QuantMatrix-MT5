const express = require('express');
const { body } = require('express-validator');
const { getMe, updateMe, changePassword } = require('../controllers/userController');
const { protect } = require('../middleware/auth');
const validate = require('../middleware/validate');

const router = express.Router();

router.use(protect);

router.get('/me', getMe);

router.put(
  '/me',
  [
    body('name')
      .optional()
      .trim()
      .notEmpty()
      .withMessage('Name cannot be empty'),
    body('email')
      .optional()
      .isEmail()
      .withMessage('Please provide a valid email'),
  ],
  validate,
  updateMe
);

router.put(
  '/change-password',
  [
    body('currentPassword')
      .notEmpty()
      .withMessage('Current password is required'),
    body('newPassword')
      .isLength({ min: 8 })
      .withMessage('New password must be at least 8 characters')
      .matches(/\d/)
      .withMessage('New password must contain at least one number')
      .matches(/[a-zA-Z]/)
      .withMessage('New password must contain at least one letter'),
  ],
  validate,
  changePassword
);

module.exports = router;
