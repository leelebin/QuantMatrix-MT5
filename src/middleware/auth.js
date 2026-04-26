const { verifyAccessToken } = require('../config/jwt');
const User = require('../models/User');

const authenticateAccessToken = async (token) => {
  if (!token) {
    const error = new Error('Not authorized to access this route');
    error.statusCode = 401;
    throw error;
  }

  const decoded = verifyAccessToken(token);
  const user = await User.findById(decoded.id);

  if (!user) {
    const error = new Error('User not found');
    error.statusCode = 401;
    throw error;
  }

  if (!user.isActive) {
    const error = new Error('Account has been deactivated');
    error.statusCode = 401;
    throw error;
  }

  return user;
};

const protect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Not authorized to access this route',
    });
  }

  try {
    req.user = await authenticateAccessToken(token);
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: error.message || 'Not authorized to access this route',
    });
  }
};

const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Role '${req.user.role}' is not authorized to access this route`,
      });
    }
    next();
  };
};

module.exports = { protect, authorize, authenticateAccessToken };
