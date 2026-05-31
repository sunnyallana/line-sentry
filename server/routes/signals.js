const express = require('express');
const mongoose = require('mongoose');
const SignalData = require('../models/SignalData');
const SensorPinMapping = require('../models/SensorPinMapping');
const ProductionRecord = require('../models/ProductionRecord');
const Config = require('../models/Config');
const { auth, apiKeyAuth } = require('../middleware/auth');
const Machine = require('../models/Machine');

const router = express.Router();

// Store last activity times for machines
const machineLastActivity = new Map();
const machineLastCycleSignal = new Map();
const machineLastPowerSignal = new Map();
const machineStates = new Map(); // Track machine states
const pendingStoppages = new Map(); // Track machines with pending stoppages
const machineRunningMinutes = new Map(); // Track running minutes per machine
const unclassifiedStoppages = new Map(); // Track unclassified stoppages

// Idempotency cache: a daemon retry resends the same {timestamp, pinData}. Without
// dedup, unit-cycle pulses get counted twice. Remember recently-seen payloads briefly.
const recentPayloads = new Map(); // key -> expiry epoch ms
const DEDUP_TTL_MS = 30 * 1000;
function isDuplicatePayload(key) {
  const now = Date.now();
  // Opportunistic cleanup so the map can't grow unbounded.
  if (recentPayloads.size > 5000) {
    for (const [k, exp] of recentPayloads) if (exp <= now) recentPayloads.delete(k);
  }
  const exp = recentPayloads.get(key);
  if (exp && exp > now) return true;
  recentPayloads.set(key, now + DEDUP_TTL_MS);
  return false;
}

// Get configuration for timeouts
const getSignalTimeouts = async () => {
  try {
    const config = await Config.findOne().lean();
    return {
      powerTimeout: (config?.signalTimeouts?.powerSignalTimeout || 5) * 60 * 1000, // 5 minutes default
      cycleTimeout: (config?.signalTimeouts?.cycleSignalTimeout || 2) * 60 * 1000   // 2 minutes default
    };
  } catch (error) {
    console.error('Error getting signal timeouts:', error);
    return { powerTimeout: 5 * 60 * 1000, cycleTimeout: 2 * 60 * 1000 };
  }
};

// Process pin data from daemon (machine-to-machine; guarded by API key)
router.post('/pin-data', apiKeyAuth, async (req, res) => {
  try {
    const { pinData, timestamp } = req.body;
    const io = req.app.get('io');

    // Validate: pinData must be a 1-byte hex string (00..ff).
    if (typeof pinData !== 'string' || !/^[0-9a-fA-F]{1,2}$/.test(pinData)) {
      return res.status(400).json({ message: 'pinData must be a hex byte string (e.g. "0f")' });
    }

    // Idempotency: drop exact retries so unit cycles aren't double-counted.
    if (isDuplicatePayload(`${timestamp || ''}:${pinData}`)) {
      return res.json({ message: 'Duplicate payload ignored', processedMachines: [] });
    }

    // Convert hex string to byte
    const byteValue = parseInt(pinData, 16);
    const currentTime = new Date(timestamp || Date.now());
    
    console.log(`Received pin data: ${pinData} (${byteValue.toString(2).padStart(8, '0')})`);

    // Get all pin mappings
    const pinMappings = await SensorPinMapping.aggregate([
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
            },
            { $unwind: '$machineId' }
          ]
        }
      },
      { $unwind: '$sensorId' }
    ]);

    const processedMachines = new Set();
    const timeouts = await getSignalTimeouts();

    // Process each pin
    for (let pinIndex = 0; pinIndex < 8; pinIndex++) {
      const pinId = `DQ.${pinIndex}`;
      const pinValue = (byteValue >> pinIndex) & 1;
      
      // Find mapping for this pin
      const mapping = pinMappings.find(m => m.pinId === pinId);
      if (!mapping || !mapping.sensorId) continue;

      const sensor = mapping.sensorId;
      const machine = sensor.machineId;
      
      if (!machine) continue;

      // Upsert instead of creating new documents
      await SignalData.findOneAndUpdate(
        { sensorId: sensor._id },
        { 
          machineId: machine._id,
          value: pinValue,
          timestamp: currentTime
        },
        { upsert: true, new: true }
      );


      if (sensor.sensorType === 'power' && pinValue === 1) {
        machineLastPowerSignal.set(machine._id.toString(), currentTime);
        
        // Emit power signal to frontend
        io.emit('power-signal', {
          machineId: machine._id.toString(),
          value: pinValue,
          timestamp: currentTime
        });
      }

      // Process unit cycle signals
      if (sensor.sensorType === 'unit-cycle' && pinValue === 1) {
        // Unit cycle detected - update production
        await updateProductionRecord(machine._id, currentTime, io);
        processedMachines.add(machine._id.toString());
        
        // Update last cycle signal time
        machineLastCycleSignal.set(machine._id.toString(), currentTime);
        
        // Clear any pending stoppages for this machine
        if (pendingStoppages.has(machine._id.toString())) {
          await resolvePendingStoppage(machine._id.toString(), currentTime, io);
          pendingStoppages.delete(machine._id.toString());
        }
      }

      // Update machine last activity
      machineLastActivity.set(machine._id.toString(), currentTime);
    }

    // Update machine states and check for stoppages
    await updateMachineStates(pinMappings, currentTime, io, timeouts);

    res.json({ 
      message: 'Pin data processed successfully',
      processedMachines: Array.from(processedMachines)
    });

  } catch (error) {
    console.error('Error processing pin data:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update machine states based on power and cycle signals
async function updateMachineStates(pinMappings, currentTime, io, timeouts) {
  const machinesWithSensors = new Set();
  
  // Get all machines with sensors
  pinMappings.forEach(mapping => {
    if (mapping.sensorId && mapping.sensorId.machineId) {
      machinesWithSensors.add(mapping.sensorId.machineId._id.toString());
    }
  });

  for (const machineId of machinesWithSensors) {
    const lastPowerTime = machineLastPowerSignal.get(machineId);
    const lastCycleTime = machineLastCycleSignal.get(machineId);
    
    const powerTimeoutAgo = new Date(currentTime.getTime() - timeouts.powerTimeout);
    const cycleTimeoutAgo = new Date(currentTime.getTime() - timeouts.cycleTimeout);
    
    const hasPower = lastPowerTime && lastPowerTime >= powerTimeoutAgo;
    const hasCycle = lastCycleTime && lastCycleTime >= cycleTimeoutAgo;
    
    let machineStatus;
    let statusColor;
    
    // New 4-state system
    if (hasPower && hasCycle) {
      machineStatus = 'running';
      statusColor = 'green';
      
      // Track running minutes
      const currentMinute = Math.floor(currentTime.getTime() / (60 * 1000));
      const lastTrackedMinute = machineRunningMinutes.get(machineId) || 0;
      
      if (currentMinute > lastTrackedMinute) {
        machineRunningMinutes.set(machineId, currentMinute);
        await updateRunningMinutes(machineId, currentTime, io);
      }
      
    } else if (hasPower && !hasCycle) {
      machineStatus = 'stoppage';
      statusColor = 'red';
      
      // Create pending stoppage if not already exists
      if (!pendingStoppages.has(machineId)) {
        await createPendingStoppage(machineId, currentTime, io);
        pendingStoppages.set(machineId, {
          startTime: currentTime,
          detectedAt: currentTime
        });
      }
      
    } else if (!hasPower && hasCycle) {
      machineStatus = 'stopped_yet_producing';
      statusColor = 'orange';
      
    } else {
      machineStatus = 'inactive';
      statusColor = 'gray';
    }

    // Update machine state
    const currentState = machineStates.get(machineId) || {};
    const newState = {
      ...currentState,
      status: machineStatus,
      color: statusColor,
      hasPower,
      hasCycle,
      lastUpdate: currentTime
    };
    
    machineStates.set(machineId, newState);

    // Update machine status in database
    try {
      await Machine.findByIdAndUpdate(machineId, { status: machineStatus });
    } catch (error) {
      console.error('Error updating machine status in database:', error);
    }

    // Emit machine state update
    io.emit('machine-state-update', {
      machineId,
      status: machineStatus,
      color: statusColor,
      hasPower,
      hasCycle,
      dbStatus: machineStatus,
      timestamp: currentTime
    });
  }
}

async function updateRunningMinutes(machineId, currentTime, io) {
  try {
    const currentHour = currentTime.getHours();
    const currentDate = currentTime.toISOString().split('T')[0];
    
    // Find or create production record for today
    let productionRecord = await ProductionRecord.findOne({
      machineId,
      startTime: {
        $gte: new Date(currentDate + 'T00:00:00.000Z'),
        $lt: new Date(currentDate + 'T23:59:59.999Z')
      }
    });

    if (!productionRecord) {
      productionRecord = new ProductionRecord({
        machineId,
        startTime: new Date(currentDate + 'T00:00:00.000Z'),
        hourlyData: []
      });
    }

    // Find or create hourly data
    let hourData = productionRecord.hourlyData.find(h => h.hour === currentHour);
    if (!hourData) {
      hourData = {
        hour: currentHour,
        unitsProduced: 0,
        defectiveUnits: 0,
        status: 'running',
        runningMinutes: 0,
        stoppageMinutes: 0,
        stoppages: []
      };
      productionRecord.hourlyData.push(hourData);
    }

    // Increment running minutes
    hourData.runningMinutes = Math.min(60, (hourData.runningMinutes || 0) + 1);
    hourData.status = 'running';
    
    await productionRecord.save();

    // Emit running time update
    io.emit('running-time-update', {
      machineId: machineId.toString(),
      hour: currentHour,
      date: currentDate,
      runningMinutes: hourData.runningMinutes,
      timestamp: currentTime
    });

  } catch (error) {
    console.error('Error updating running minutes:', error);
  }
}

async function createPendingStoppage(machineId, currentTime, io) {
  try {
    const currentHour = currentTime.getHours();
    const currentDate = currentTime.toISOString().split('T')[0];
    
    // Find production record
    let productionRecord = await ProductionRecord.findOne({
      machineId,
      startTime: {
        $gte: new Date(currentDate + 'T00:00:00.000Z'),
        $lt: new Date(currentDate + 'T23:59:59.999Z')
      }
    });

    if (!productionRecord) {
      productionRecord = new ProductionRecord({
        machineId,
        startTime: new Date(currentDate + 'T00:00:00.000Z'),
        hourlyData: []
      });
    }

    // Find or create hourly data
    let hourData = productionRecord.hourlyData.find(h => h.hour === currentHour);
    if (!hourData) {
      hourData = {
        hour: currentHour,
        unitsProduced: 0,
        defectiveUnits: 0,
        status: 'stoppage',
        runningMinutes: 0,
        stoppageMinutes: 0,
        stoppages: []
      };
      productionRecord.hourlyData.push(hourData);
    }

    // Add pending stoppage record only if it doesn't exist
    const existingUnclassified = hourData.stoppages.find(s => 
      s.reason === 'unclassified' && s.isPending
    );
    
    if (!existingUnclassified) {
      const newStoppage = {
        _id: new mongoose.Types.ObjectId(), // FIX: Generate ObjectId
        reason: 'unclassified',
        description: 'Automatic stoppage detection - awaiting categorization',
        startTime: currentTime,
        endTime: null,
        duration: 0,
        isPending: true,
        isClassified: false
      };

      hourData.stoppages.push(newStoppage);
      hourData.status = 'stoppage';
      
      // Save to database
      await productionRecord.save();
      
      // Store in memory
      unclassifiedStoppages.set(machineId, {
        id: newStoppage._id.toString(), // FIX: Store as string
        startTime: currentTime,
        hour: currentHour,
        date: currentDate
      });

      // Emit socket event
      io.emit('unclassified-stoppage-detected', {
        machineId: machineId.toString(),
        hour: currentHour,
        date: currentDate,
        stoppageStart: currentTime,
        pendingStoppageId: newStoppage._id.toString(), // FIX: Use generated ID
        timestamp: currentTime
      });
    }

  } catch (error) {
    console.error('Error creating pending stoppage:', error);
  }
}

async function resolvePendingStoppage(machineId, currentTime, io) {
  try {
    const currentHour = currentTime.getHours();
    const currentDate = currentTime.toISOString().split('T')[0];
    
    // Find production record
    const productionRecord = await ProductionRecord.findOne({
      machineId,
      startTime: {
        $gte: new Date(currentDate + 'T00:00:00.000Z'),
        $lt: new Date(currentDate + 'T23:59:59.999Z')
      }
    });

    if (productionRecord) {
      const hourData = productionRecord.hourlyData.find(h => h.hour === currentHour);
      if (hourData) {
        // Find and remove pending stoppages
        hourData.stoppages = hourData.stoppages.filter(s => s.reason !== 'unclassified');
        hourData.status = 'running';
        
        await productionRecord.save();
        unclassifiedStoppages.delete(machineId);
      }
    }

    // Emit stoppage resolved event
    io.emit('stoppage-resolved', {
      machineId: machineId.toString(),
      timestamp: currentTime
    });

  } catch (error) {
    console.error('Error resolving pending stoppage:', error);
  }
}

async function updateOngoingStoppages(currentTime, io) { // FIX: Add io parameter
  try {
    for (const [machineId, stoppageInfo] of unclassifiedStoppages) {
      const { id, startTime, hour, date } = stoppageInfo;
      const duration = Math.floor((currentTime - startTime) / 60000); // minutes
      
      const productionRecord = await ProductionRecord.findOne({
        machineId,
        startTime: { $gte: new Date(date + 'T00:00:00.000Z'), $lt: new Date(date + 'T23:59:59.999Z') }
      });

      if (productionRecord) {
        const hourData = productionRecord.hourlyData.find(h => h.hour === hour);
        if (hourData) {
          // FIX: Use string comparison for ID matching
          const stoppageIndex = hourData.stoppages.findIndex(s => s._id.toString() === id);
          if (stoppageIndex >= 0) {
            // Update duration
            hourData.stoppages[stoppageIndex].duration = duration;
            
            // Update stoppage minutes
            hourData.stoppageMinutes = (hourData.stoppages || [])
              .reduce((sum, s) => sum + (s.duration || 0), 0);

            hourData.stoppages[stoppageIndex].duration = Math.min(60, duration);
            
            await productionRecord.save();
            
            // Emit update to frontend
            io.emit('stoppage-updated', {
              machineId,
              hour,
              date,
              stoppageId: id,
              duration
            });
          }
        }
      }
    }
  } catch (error) {
    console.error('Error updating ongoing stoppages:', error);
  }
}

// Get unclassified stoppages count for dashboard
router.get('/unclassified-stoppages-count', auth, async (req, res) => {
  try {
    // Optimized aggregation pipeline
    const result = await ProductionRecord.aggregate([
      {
        $match: {
          'hourlyData.stoppages.reason': 'unclassified'
        }
      },
      {
        $project: {
          unclassifiedCount: {
            $size: {
              $filter: {
                input: {
                  $reduce: {
                    input: '$hourlyData',
                    initialValue: [],
                    in: { $concatArrays: ['$$value', '$$this.stoppages'] }
                  }
                },
                cond: { $eq: ['$$this.reason', 'unclassified'] }
              }
            }
          }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$unclassifiedCount' }
        }
      }
    ]);
    
    res.json({ count: result[0]?.total || 0 });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

async function updateProductionRecord(machineId, currentTime, io) {
  try {
    const currentHour = currentTime.getHours();
    const currentDate = currentTime.toISOString().split('T')[0];
    
    // Find or create production record for today
    let productionRecord = await ProductionRecord.findOne({
      machineId,
      startTime: {
        $gte: new Date(currentDate + 'T00:00:00.000Z'),
        $lt: new Date(currentDate + 'T23:59:59.999Z')
      }
    });

    if (!productionRecord) {
      productionRecord = new ProductionRecord({
        machineId,
        startTime: new Date(currentDate + 'T00:00:00.000Z'),
        hourlyData: []
      });
    }

    // Find or create hourly data
    let hourData = productionRecord.hourlyData.find(h => h.hour === currentHour);
    if (!hourData) {
      hourData = {
        hour: currentHour,
        unitsProduced: 0,
        defectiveUnits: 0,
        status: 'running',
        runningMinutes: 0,
        stoppageMinutes: 0,
        stoppages: []
      };
      productionRecord.hourlyData.push(hourData);
    }

    // Increment units produced
    hourData.unitsProduced += 1;
    hourData.status = 'running';

    // Update total units produced
    productionRecord.unitsProduced = productionRecord.hourlyData.reduce(
      (sum, h) => sum + h.unitsProduced, 0
    );
    
    productionRecord.lastActivityTime = currentTime;
    await productionRecord.save();

    // Emit socket event for real-time updates
    io.emit('production-update', {
      machineId: machineId.toString(),
      hour: currentHour,
      date: currentDate,
      unitsProduced: hourData.unitsProduced,
      status: hourData.status,
      runningMinutes: hourData.runningMinutes,
      stoppageMinutes: hourData.stoppageMinutes,
      timestamp: currentTime
    });

    console.log(`Updated production for machine ${machineId}: +1 unit (total: ${hourData.unitsProduced})`);

  } catch (error) {
    console.error('Error updating production record:', error);
  }
}

// Get recent signals for a machine
router.get('/machine/:machineId/recent', auth, async (req, res) => {
  try {
    const { machineId } = req.params;
    
    // Return all current signals for the machine (one per sensor)
    const signals = await SignalData.find({ machineId })
      .populate('sensorId')
      .lean();

    res.json(signals);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Add/update signal data
router.post('/', auth, async (req, res) => {
  try {
    const { sensorId, machineId, value, timestamp } = req.body;
    
    // Update existing signal or create new if doesn't exist
    await SignalData.findOneAndUpdate(
      { sensorId },
      { 
        machineId,
        value,
        timestamp: timestamp ? new Date(timestamp) : new Date()
      },
      { upsert: true, new: true }
    );

    res.status(201).json({ message: 'Signal data updated successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Single global monitor that ticks ongoing unclassified-stoppage durations.
// Started once from server/index.js after Socket.IO is ready (this replaces the
// per-request setInterval that previously leaked one timer per pin per request).
let stoppageMonitor = null;
function startStoppageMonitor(io) {
  if (stoppageMonitor) return stoppageMonitor;
  stoppageMonitor = setInterval(() => updateOngoingStoppages(new Date(), io), 60000);
  if (typeof stoppageMonitor.unref === 'function') stoppageMonitor.unref();
  return stoppageMonitor;
}

module.exports = router;
module.exports.startStoppageMonitor = startStoppageMonitor;