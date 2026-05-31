const express = require('express');
const Sensor = require('../models/Sensor');
const SensorPinMapping = require('../models/SensorPinMapping');
const { auth, adminAuth } = require('../middleware/auth');
const Machine = require('../models/Machine');
const mongoose = require('mongoose');
const { safeSearchRegex } = require('../utils/sanitize');

const router = express.Router();

// Get all sensors
router.get('/', auth, async (req, res) => {
  try {
    const sensors = await Sensor.find({ isActive: true }).populate('machineId').lean();
    res.json(sensors);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Add this new endpoint for paginated sensors
router.get('/admin/all', auth, adminAuth, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search = '',
      department = '',
      status = '',
      sensorType = '',
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    // Convert page and limit to numbers
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Build aggregation pipeline for better performance
    let pipeline = [];

    // Match stage for filtering
    let matchStage = {};
    
    const searchRegex = safeSearchRegex(search);
    if (searchRegex) {
      matchStage.$or = [
        { name: searchRegex },
        { description: searchRegex },
        { sensorType: searchRegex }
      ];
    }

    // Filter by active status
    if (status !== '') {
      matchStage.isActive = status === 'true';
    }

    // Filter by sensor type
    if (sensorType.trim()) {
      matchStage.sensorType = sensorType;
    }

    pipeline.push({ $match: matchStage });

    // Lookup machine and department data
    pipeline.push({
      $lookup: {
        from: 'machines',
        localField: 'machineId',
        foreignField: '_id',
        as: 'machineId',
        pipeline: [
          {
            $lookup: {
              from: 'departments',
              localField: 'departmentId',
              foreignField: '_id',
              as: 'departmentId'
            }
          },
          { $unwind: '$departmentId' }
        ]
      }
    });
    
    pipeline.push({ $unwind: '$machineId' });

    // Filter by department after lookup
    if (department.trim()) {
      pipeline.push({
        $match: {
          'machineId.departmentId._id': new mongoose.Types.ObjectId(department)
        }
      });
    }

    // Build sort object
    const sortObj = {};
    sortObj[sortBy] = sortOrder === 'asc' ? 1 : -1;

    // Add sort, skip, and limit
    pipeline.push({ $sort: sortObj });
    
    // Get total count before pagination
    const countPipeline = [...pipeline, { $count: "total" }];
    
    // Add pagination
    pipeline.push({ $skip: skip });
    pipeline.push({ $limit: limitNum });

    const [sensors, totalResult] = await Promise.all([
      Sensor.aggregate(pipeline),
      Sensor.aggregate(countPipeline)
    ]);

    const totalSensors = totalResult[0]?.total || 0;

    // Calculate pagination info
    const totalPages = Math.ceil(totalSensors / limitNum);
    const hasNextPage = pageNum < totalPages;
    const hasPrevPage = pageNum > 1;

    res.json({
      sensors,
      pagination: {
        currentPage: pageNum,
        totalPages,
        totalSensors,
        limit: limitNum,
        hasNextPage,
        hasPrevPage,
        nextPage: hasNextPage ? pageNum + 1 : null,
        prevPage: hasPrevPage ? pageNum - 1 : null
      },
      filters: {
        search,
        department,
        status,
        sensorType,
        sortBy,
        sortOrder
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Get sensors by machine
router.get('/machine/:machineId', auth, async (req, res) => {
  try {
    const sensors = await Sensor.find({ 
      machineId: req.params.machineId, 
      isActive: true 
    }).populate('machineId').lean();
    res.json(sensors);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Create sensor (Admin only)
router.post('/', auth, adminAuth, async (req, res) => {
  try {
    const sensor = new Sensor(req.body);
    await sensor.save();
    res.status(201).json(sensor);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Update sensor (Admin only)
router.put('/:id', auth, adminAuth, async (req, res) => {
  try {
    const sensor = await Sensor.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    ).populate('machineId');
    
    if (!sensor) {
      return res.status(404).json({ message: 'Sensor not found' });
    }
    
    res.json(sensor);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/:id', auth, adminAuth, async (req, res) => {
  try {
    // Delete any pin mappings first
    await SensorPinMapping.deleteMany({ sensorId: req.params.id });
    
    // Then hard delete the sensor
    const sensor = await Sensor.findByIdAndDelete(req.params.id);
    
    if (!sensor) {
      return res.status(404).json({ message: 'Sensor not found' });
    }
    
    res.json({ message: 'Sensor permanently deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Map sensor to pin (Admin only)
router.post('/pin-mapping', auth, adminAuth, async (req, res) => {
  try {
    const { sensorId, pinId } = req.body;
    
    // Check if pin is already occupied
    const existingMapping = await SensorPinMapping.findOne({ pinId });
    if (existingMapping) {
      return res.status(400).json({ message: 'Pin is already occupied' });
    }

    // Check if sensor is already mapped
    const existingSensorMapping = await SensorPinMapping.findOne({ sensorId });
    if (existingSensorMapping) {
      return res.status(400).json({ message: 'Sensor is already mapped to a pin' });
    }

    const mapping = new SensorPinMapping({ sensorId, pinId });
    await mapping.save();
    res.status(201).json(mapping);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Get pin mappings
router.get('/pin-mappings', auth, adminAuth, async (req, res) => {
  try {
    const mappings = await SensorPinMapping.aggregate([
      {
        $lookup: {
          from: 'sensors',
          localField: 'sensorId',
          foreignField: '_id',
          as: 'sensorId',
          pipeline: [
            {
              $lookup: {
                from: 'machines',
                localField: 'machineId',
                foreignField: '_id',
                as: 'machineId'
              }
            },
            { $unwind: '$machineId' }
          ]
        }
      },
      { $unwind: '$sensorId' }
    ]);
    res.json(mappings);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete pin mapping (Admin only)
router.delete('/pin-mapping/:id', auth, adminAuth, async (req, res) => {
  try {
    const mapping = await SensorPinMapping.findByIdAndDelete(req.params.id);
    
    if (!mapping) {
      return res.status(404).json({ message: 'Pin mapping not found' });
    }
    
    res.json({ message: 'Pin mapping permanently deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;