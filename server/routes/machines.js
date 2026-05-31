const express = require('express');
const Machine = require('../models/Machine');
const SignalData = require('../models/SignalData');
const Sensor = require('../models/Sensor');
const ProductionRecord = require('../models/ProductionRecord');
const { auth, adminAuth } = require('../middleware/auth');

const router = express.Router();

// Get machines by department
router.get('/department/:departmentId', auth, async (req, res) => {
  try {
    // Check if operator is accessing their own department
    if (req.user.role === 'operator' && req.user.departmentId?._id.toString() !== req.params.departmentId) {
      return res.status(403).json({ message: 'Access denied to this department' });
    }

    const machines = await Machine.find({ 
      departmentId: req.params.departmentId, 
      isActive: true 
    }).populate('departmentId').lean();
    
    res.json(machines);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Get machine by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const machine = await Machine.findById(req.params.id).populate('departmentId').lean();
    if (!machine) {
      return res.status(404).json({ message: 'Machine not found' });
    }

    // Check if operator is accessing machine from their department
    if (req.user.role === 'operator' && req.user.departmentId?._id.toString() !== machine.departmentId._id.toString()) {
      return res.status(403).json({ message: 'Access denied to this machine' });
    }

    res.json(machine);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all machines (Admin only)
router.get('/', auth, adminAuth, async (req, res) => {
  try {
    const machines = await Machine.find({ isActive: true }).populate('departmentId').lean();
    res.json(machines);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Create machine (Admin only)
router.post('/', auth, adminAuth, async (req, res) => {
  try {
    const machine = new Machine({
      ...req.body,
      dimensions: req.body.dimensions || { width: 200, height: 200 },
      status: req.body.status || 'inactive'
    });
    await machine.save();
    res.status(201).json(machine);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Update machine
router.put('/:id', auth, adminAuth, async (req, res) => {
  try {
    const machine = await Machine.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    if (!machine) {
      return res.status(404).json({ message: 'Machine not found' });
    }
    res.json(machine);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Update machine position (for drag and drop)
router.patch('/:id/position', auth, adminAuth, async (req, res) => {
  try {
    const { x, y, width, height } = req.body;
    const machine = await Machine.findByIdAndUpdate(
      req.params.id,
      { 
        position: { x, y },
        dimensions: { width, height }
      },
      { new: true }
    );
    if (!machine) {
      return res.status(404).json({ message: 'Machine not found' });
    }
    res.json(machine);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete machine (Admin only)
router.delete('/:id', auth, adminAuth, async (req, res) => {
  try {
    const machineId = req.params.id;
    
    // First delete all related data
    await Promise.all([
      Sensor.deleteMany({ machineId }),
      ProductionRecord.deleteMany({ machineId }),
      SignalData.deleteMany({ machineId })
    ]);
    
    // Then delete the machine
    const machine = await Machine.findByIdAndDelete(machineId);
    
    if (!machine) {
      return res.status(404).json({ message: 'Machine not found' });
    }
    
    res.json({ message: 'Machine and all related data deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;