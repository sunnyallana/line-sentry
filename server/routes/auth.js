const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Department = require('../models/Department');
const { auth } = require('../middleware/auth');
const bcrypt = require('bcryptjs');
const axios = require('axios');

const router = express.Router();

// reCAPTCHA is enforced whenever a secret key is configured. In production the
// key is required at startup (see server/index.js), so CAPTCHA is always
// mandatory there; in local dev without a key it is skipped for convenience.
const captchaEnabled = () => !!process.env.RECAPTCHA_SECRET_KEY;

const verifyCaptcha = async (token) => {
  if (!token) return false; // no token => fail closed

  try {
    const response = await axios.post('https://www.google.com/recaptcha/api/siteverify', null, {
      params: {
        secret: process.env.RECAPTCHA_SECRET_KEY,
        response: token
      },
      timeout: 5000
    });

    return response.data.success === true;
  } catch (error) {
    console.error('CAPTCHA verification error:', error.message);
    return false;
  }
};
// Login
router.post('/login', async (req, res) => {
  try {
    const { username, password, captchaToken } = req.body;

    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ message: 'Username and password are required' });
    }

    // CAPTCHA is mandatory whenever it is configured (always in production).
    if (captchaEnabled()) {
      const captchaValid = await verifyCaptcha(captchaToken);
      if (!captchaValid) {
        return res.status(400).json({ message: 'CAPTCHA verification failed' });
      }
    }

    const user = await User.findOne({ username }).populate('departmentId');
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    if (!user.isActive) {
      return res.status(401).json({ message: 'Account is deactivated' });
    }

    const token = jwt.sign(
      { userId: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        department: user.departmentId
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Get current user
router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .populate('departmentId')
      .select('-password')
      .lean();
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Initialize demo accounts (dev/seed only — creates known-credential accounts).
router.post('/init-demo', async (req, res) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ message: 'Demo initialization is disabled in production' });
    }
    // Create demo department
    const demoDept = await Department.findOneAndUpdate(
      { name: 'Manufacturing Department' },
      {
        name: 'Manufacturing Department',
        description: 'Main manufacturing department with injection molding machines'
      },
      { upsert: true, new: true }
    );

    const adminPassword = await bcrypt.hash('admin123', 12);
    const operatorPassword = await bcrypt.hash('operator123', 12);

    // Create demo admin
    await User.findOneAndUpdate(
      { username: 'admin' },
      {
        username: 'admin',
        email: 'admin@company.com',
        password: adminPassword,
        role: 'admin',
        isActive: true
      },
      { upsert: true, new: true }
    );

    // Create demo operator
    await User.findOneAndUpdate(
      { username: 'operator' },
      {
        username: 'operator',
        email: 'operator@company.com',
        password: operatorPassword,
        role: 'operator',
        departmentId: demoDept._id,
        isActive: true
      },
      { upsert: true, new: true }
    );

    res.json({ message: 'Demo accounts initialized successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error initializing demo accounts' });
  }
});

module.exports = router;