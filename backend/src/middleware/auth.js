const jwt = require('jsonwebtoken');
const { sendError } = require('../utils/http');

function authRequired(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return sendError(res, 'Authorization Bearer token required', 401);
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    return next();
  } catch {
    return sendError(res, 'Invalid or expired token', 401);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return sendError(res, 'Authentication required', 401);
    }

    if (!roles.includes(req.user.role)) {
      return sendError(res, 'You do not have permission to access this resource', 403);
    }

    next();
  };
}

const admin1Only = requireRole('admin_1');
const admin2Only = requireRole('admin_2');
const populationAccess = requireRole('admin_1', 'admin_2');

// Dipertahankan untuk kompatibilitas.
// Semua endpoint yang sebelumnya memakai adminOnly
// sekarang dianggap sebagai akses Admin 1.
const adminOnly = admin1Only;

module.exports = {
  authRequired,
  requireRole,
  adminOnly,
  admin1Only,
  admin2Only,
  populationAccess
};