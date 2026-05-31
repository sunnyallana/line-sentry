const express = require('express');
const Config = require('../models/Config');
const { auth, adminAuth } = require('../middleware/auth');

const router = express.Router();

// Route for fetching shift details (accessible to any authenticated user)
router.get('/shifts', auth, async (req, res) => {
  try {
    const config = await Config.findOne().select('shifts -_id').lean();
    if (!config) {
      return res.json({ shifts: [] });
    }
    res.json(config.shifts);
  } catch (error) { 
    console.error('Shift config fetch error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get configuration
router.get('/', auth, adminAuth, async (req, res) => {
  try {
    let config = await Config.findOne().lean();
    if (!config) {
      // Create with defaults and return lean version
      const newConfig = new Config();
      await newConfig.save();
      config = await Config.findById(newConfig._id).lean();
    }
    res.json(config);
  } catch (error) { 
    console.error('Config fetch error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update configuration
router.put('/', auth, adminAuth, async (req, res) => {
  try {
    const configData = req.body;
    
    // Use findOneAndUpdate with upsert to handle the version conflict
    const config = await Config.findOneAndUpdate(
      {}, // Empty filter to match any document
      configData,
      { 
        new: true, 
        upsert: true,
        runValidators: true
      }
    );
    
    res.json(config);
  } catch (error) {
    console.error('Config update error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;