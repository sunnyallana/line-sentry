const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');

// Guards machine-to-machine endpoints (the PLC daemon's signal ingestion).
// Compares the X-API-Key header to DAEMON_API_KEY in constant time.
const apiKeyAuth = (req, res, next) => {
  const provided = req.header('X-API-Key') || '';
  const expected = process.env.DAEMON_API_KEY || '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ message: 'Invalid or missing API key.' });
  }
  next();
};

const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ message: 'Access denied. No token provided.' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId).populate('departmentId');
    
    if (!user || !user.isActive) {
      return res.status(401).json({ message: 'Invalid token.' });
    }

    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({ message: 'Invalid token.' });
  }
};

const adminAuth = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Access denied. Admin role required.' });
  }
  next();
};

module.exports = { auth, adminAuth, apiKeyAuth };