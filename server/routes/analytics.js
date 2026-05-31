const express = require('express');
const mongoose = require('mongoose');
const ProductionRecord = require('../models/ProductionRecord');
const Machine = require('../models/Machine');
const Config = require('../models/Config');
const User = require('../models/User');
const Mold = require('../models/Mold');
const { auth } = require('../middleware/auth');

const router = express.Router();

const PERIODS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000
};

// Helper function to get date range based on timeframe
function getDateRange(timeframe) {
  const now = new Date();
  
  const startDate = new Date(now);
  
  switch(timeframe) {
    case 'today':
      startDate.setUTCHours(0, 0, 0, 0);
      return { 
        startDate,
        endDate: new Date(now)
      };
    case 'week':
      // Get start of week (Sunday)
      startDate.setUTCDate(startDate.getUTCDate() - startDate.getUTCDay());
      startDate.setUTCHours(0, 0, 0, 0);
      return { 
        startDate,
        endDate: new Date(now)
      };
    case 'month':
      startDate.setUTCDate(1);
      startDate.setUTCHours(0, 0, 0, 0);
      return { 
        startDate,
        endDate: new Date(now)
      };
    case 'custom':
      // For custom, we'll expect explicit start/end dates
      return null;
    default:
      // Default to last 7 days
      startDate.setUTCDate(startDate.getUTCDate() - 7);
      return { 
        startDate,
        endDate: new Date(now)
      };
  }
}

// Helper function to format date as YYYY-MM-DD
function formatDate(date) {
  return date.toISOString().split('T')[0];
}

// Helper function to get start and end of day
function getDayRange(date) {
  const start = new Date(date);
  start.setUTCHours(0, 0, 0, 0);
  
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 1);
  
  return { start, end };
}

// Machine stats calculation with custom timeframe
async function calculateMachineStats(machineId, startDate, endDate) {
  // Convert dates to UTC start/end of day
  const localStart = new Date(startDate);
  localStart.setUTCHours(0, 0, 0, 0);
  
  const localEnd = new Date(endDate);
  localEnd.setUTCHours(23, 59, 59, 999);
  
  const aggregation = await ProductionRecord.aggregate([
    {
      $match: {
        machineId: new mongoose.Types.ObjectId(machineId),
        startTime: { 
          $gte: localStart,
          $lte: localEnd
        }
      }
    },
    {
      $unwind: "$hourlyData"
    },
    {
      $lookup: {
        from: 'molds',
        localField: 'hourlyData.moldId',
        foreignField: '_id',
        as: 'moldData'
      }
    },
    {
      $addFields: {
        moldData: { $arrayElemAt: ["$moldData", 0] }
      }
    },
    {
      $group: {
        _id: null,
        totalUnitsProduced: { $sum: "$hourlyData.unitsProduced" },
        totalDefectiveUnits: { $sum: "$hourlyData.defectiveUnits" },
        totalRunningMinutes: { $sum: "$hourlyData.runningMinutes" },
        totalStoppageMinutes: { $sum: "$hourlyData.stoppageMinutes" },
        totalStoppages: { $sum: { $size: "$hourlyData.stoppages" } },
        breakdownStoppages: {
          $sum: {
            $size: {
              $filter: {
                input: "$hourlyData.stoppages",
                as: "stoppage",
                cond: { $eq: ["$$stoppage.reason", "breakdown"] }
              }
            }
          }
        },
        totalBreakdownMinutes: {
          $sum: {
            $sum: {
              $map: {
                input: {
                  $filter: {
                    input: "$hourlyData.stoppages",
                    as: "stoppage",
                    cond: { $eq: ["$$stoppage.reason", "breakdown"] }
                  }
                },
                as: "bs",
                in: "$$bs.duration"
              }
            }
          }
        },
        totalExpectedUnits: {
          $sum: {
            $cond: [
              { $gt: ["$moldData.productionCapacityPerHour", 0] },
              {
                $multiply: [
                  { $divide: ["$moldData.productionCapacityPerHour", 60] },
                  "$hourlyData.runningMinutes"
                ]
              },
              0
            ]
          }
        }
      }
    }
  ]);

  if (aggregation.length === 0) {
    return {
      totalUnitsProduced: 0,
      totalDefectiveUnits: 0,
      oee: 0,
      mtbf: 0,
      mttr: 0,
      availability: 0,
      quality: 0,
      performance: 0,
      totalRunningMinutes: 0,
      totalStoppageMinutes: 0,
      breakdownStoppages: 0,
      totalBreakdownMinutes: 0
    };
  }

  const stats = aggregation[0];
  
  // Calculate metrics
  const totalAvailableMinutes = stats.totalRunningMinutes + stats.totalStoppageMinutes;
  const availability = totalAvailableMinutes > 0 
    ? stats.totalRunningMinutes / totalAvailableMinutes
    : 0;
  
  const quality = stats.totalUnitsProduced > 0 
    ? (stats.totalUnitsProduced - stats.totalDefectiveUnits) / stats.totalUnitsProduced
    : 0;
  
  const performance = stats.totalExpectedUnits > 0 
    ? stats.totalUnitsProduced / stats.totalExpectedUnits
    : 0;
  
  const oee = availability * quality * performance;

  // Calculate MTBF and MTTR
  const mtbf = stats.breakdownStoppages > 0 
    ? stats.totalRunningMinutes / stats.breakdownStoppages 
    : 0;
    
  const mttr = stats.breakdownStoppages > 0 
    ? stats.totalBreakdownMinutes / stats.breakdownStoppages 
    : 0;

  return {
    totalUnitsProduced: stats.totalUnitsProduced,
    totalDefectiveUnits: stats.totalDefectiveUnits,
    oee: Math.round(oee * 100),
    mtbf: Math.round(mtbf),
    mttr: Math.round(mttr),
    availability: Math.round(availability * 100),
    quality: Math.round(quality * 100),
    performance: Math.round(performance * 100),
    totalRunningMinutes: stats.totalRunningMinutes,
    totalStoppageMinutes: stats.totalStoppageMinutes,
    breakdownStoppages: stats.breakdownStoppages,
    totalBreakdownMinutes: stats.totalBreakdownMinutes
  };
}

// Get production timeline for a machine with custom timeframe support
router.get('/production-timeline/:machineId', auth, async (req, res) => {
  try {
    const { machineId } = req.params;
    const { timeframe, startDate: startDateParam, endDate: endDateParam } = req.query;

    // Determine date range based on timeframe
    let startDate, endDate;
    if (timeframe === 'custom' && startDateParam && endDateParam) {
      startDate = new Date(startDateParam);
      endDate = new Date(endDateParam);
    } else {
      const range = getDateRange(timeframe);
      if (!range) {
        return res.status(400).json({ message: 'Invalid timeframe or missing dates' });
      }
      startDate = range.startDate;
      endDate = range.endDate;
    }

    // Validate dates
    if (isNaN(startDate.getTime())) {
      return res.status(400).json({ message: 'Invalid start date' });
    }
    if (isNaN(endDate.getTime())) {
      return res.status(400).json({ message: 'Invalid end date' });
    }
    if (startDate > endDate) {
      return res.status(400).json({ message: 'Start date must be before end date' });
    }

    // Check access permissions
    const machine = await Machine.findById(machineId).populate('departmentId').lean();
    if (!machine) {
      return res.status(404).json({ message: 'Machine not found' });
    }

    if (req.user.role === 'operator' && req.user.departmentId?._id.toString() !== machine.departmentId._id.toString()) {
      return res.status(403).json({ message: 'Access denied to this machine' });
    }

    // Generate all dates in the range for the timeline
    const allDates = [];
    for (let d = new Date(startDate); d <= endDate; d.setUTCDate(d.getUTCDate() + 1)) {
      allDates.push(new Date(d));
    }

    // Use aggregation pipeline for better performance
    const productionRecords = await ProductionRecord.aggregate([
      {
        $match: {
          machineId: new mongoose.Types.ObjectId(machineId),
          startTime: { 
            $gte: startDate,
            $lte: endDate
          }
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: 'operatorId',
          foreignField: '_id',
          as: 'operatorId'
        }
      },
      {
        $lookup: {
          from: 'molds',
          localField: 'moldId',
          foreignField: '_id',
          as: 'moldId'
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: 'hourlyData.operatorId',
          foreignField: '_id',
          as: 'hourlyOperators'
        }
      },
      {
        $lookup: {
          from: 'molds',
          localField: 'hourlyData.moldId',
          foreignField: '_id',
          as: 'hourlyMolds'
        }
      },
      {
        $addFields: {
          operatorId: { $arrayElemAt: ['$operatorId', 0] },
          moldId: { $arrayElemAt: ['$moldId', 0] },
          hourlyData: {
            $map: {
              input: '$hourlyData',
              as: 'hour',
              in: {
                $mergeObjects: [
                  '$$hour',
                  {
                    operatorId: {
                      $arrayElemAt: [
                        {
                          $filter: {
                            input: '$hourlyOperators',
                            cond: { $eq: ['$$this._id', '$$hour.operatorId'] }
                          }
                        },
                        0
                      ]
                    },
                    moldId: {
                      $arrayElemAt: [
                        {
                          $filter: {
                            input: '$hourlyMolds',
                            cond: { $eq: ['$$this._id', '$$hour.moldId'] }
                          }
                        },
                        0
                      ]
                    }
                  }
                ]
              }
            }
          }
        }
      }
    ]);

    // Generate timeline data for all dates in the range
    const timeline = allDates.map(date => {
      const { start: dayStart, end: dayEnd } = getDayRange(date);

      const dayData = {
        date: formatDate(date),
        hours: []
      };

      // Find production record for this day
      const dayRecord = productionRecords.find(record => {
        const recordDate = new Date(record.startTime);
        return formatDate(recordDate) === dayData.date;
      });

      for (let hour = 0; hour < 24; hour++) {
        const hourData = dayRecord?.hourlyData?.find(h => h.hour === hour);
        
        // Calculate running vs stoppage time
        const runningMinutes = hourData?.runningMinutes || 0;
        const stoppageMinutes = hourData?.stoppages?.reduce((sum, s) => sum + (s.duration || 0), 0) || 0;

        // Determine status based on activity
        let status = 'inactive';
        if (runningMinutes > 0) {
          status = stoppageMinutes > runningMinutes ? 'stoppage' : 'running';
        } else if (stoppageMinutes > 0) {
          status = 'stoppage';
        }

        dayData.hours.push({
          hour,
          unitsProduced: hourData?.unitsProduced || 0,
          defectiveUnits: hourData?.defectiveUnits || 0,
          status: hourData?.status || status,
          operator: hourData?.operatorId || dayRecord?.operatorId,
          mold: hourData?.moldId || dayRecord?.moldId,
          stoppages: hourData?.stoppages || [],
          runningMinutes,
          stoppageMinutes
        });
      }

      return dayData;
    });

    res.json({
      timeline,
      timeframe,
      startDate: formatDate(startDate),
      endDate: formatDate(endDate)
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Add stoppage record
router.post('/stoppage', auth, async (req, res) => {
  try {
    const { machineId, hour, date, reason, description, duration, pendingStoppageId, sapNotificationNumber } = req.body;
    const io = req.app.get('io');
    
    // Early validation
    if (reason === 'breakdown') {
      if (!sapNotificationNumber?.trim()) {
        return res.status(400).json({ message: 'SAP number required' });
      }
      if (!/^\d+$/.test(sapNotificationNumber.trim())) {
        return res.status(400).json({ message: 'Invalid SAP number format' });
      }
    }

    // Date range for query
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const dayEnd = new Date(`${date}T23:59:59.999Z`);
    
    // Find or create record efficiently
    let productionRecord = await ProductionRecord.findOneAndUpdate(
      { machineId, startTime: { $gte: dayStart, $lt: dayEnd } },
      {},
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Find or initialize hour data
    let hourData = productionRecord.hourlyData.find(h => h.hour === hour);
    if (!hourData) {
      hourData = {
        hour,
        unitsProduced: 0,
        defectiveUnits: 0,
        status: 'stoppage',
        runningMinutes: 0,
        stoppageMinutes: 0,
        stoppages: []
      };
      productionRecord.hourlyData.push(hourData);
    }

    // Handle pending stoppages
    if (pendingStoppageId) {
      const index = hourData.stoppages.findIndex(s => 
        s._id?.toString() === pendingStoppageId || s.reason === 'unclassified'
      );
      
      if (index >= 0) {
        const now = new Date();
        const actualDuration = Math.floor((now - hourData.stoppages[index].startTime) / 60000);
        
        hourData.stoppages[index] = {
          ...hourData.stoppages[index],
          reason,
          description,
          endTime: now,
          duration: actualDuration,
          sapNotificationNumber: reason === 'breakdown' ? sapNotificationNumber : undefined,
          isPending: false,
          isClassified: true
        };
      } else {
        return res.status(404).json({ message: 'Pending stoppage not found' });
      }
    } 
    // Add new stoppage
    else {
      const stoppageStart = new Date(`${date}T${hour.toString().padStart(2, '0')}:00:00Z`);
      const stoppageEnd = new Date(stoppageStart.getTime() + duration * 60000);
      
      hourData.stoppages.push({
        reason,
        description,
        startTime: stoppageStart,
        endTime: stoppageEnd,
        duration,
        isPending: false,
        isClassified: true,
        ...(reason === 'breakdown' && { sapNotificationNumber })
      });
    }

    // Update stoppage minutes
    hourData.stoppageMinutes = hourData.stoppages.reduce((sum, s) => sum + (s.duration || 0), 0);
    hourData.status = 'stoppage';

    // Optimized save
    await productionRecord.save();

    // Socket emission
    io.emit('stoppage-added', {
      machineId,
      hour,
      date,
      stoppage: { reason, description, duration, sapNotificationNumber },
      timestamp: new Date()
    });

    res.status(201).json({ message: 'Stoppage recorded' });
  } catch (error) {
    console.error('Stoppage error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Production assignment
router.post('/production-assignment', auth, async (req, res) => {
  try {
    const { machineId, hour, date, operatorId, moldId, defectiveUnits, applyToShift } = req.body;
    const io = req.app.get('io');
    
    // Validate and convert operatorId to ObjectId if provided
    let validOperatorId = undefined;
    
    if (operatorId && operatorId.trim() !== '') {
      // Check if it's already a valid ObjectId
      if (mongoose.Types.ObjectId.isValid(operatorId)) {
        validOperatorId = new mongoose.Types.ObjectId(operatorId);
      } else {
        // Try to find user by username
        const User = require('../models/User');
        const user = await User.findOne({ username: operatorId });
        if (user) {
          validOperatorId = user._id;
        } else {
          return res.status(400).json({ message: 'Invalid operator specified' });
        }
      }
    }

    // Validate and convert moldId to ObjectId if provided
    let validMoldId = undefined;
    if (moldId && moldId.trim() !== '') {
      if (mongoose.Types.ObjectId.isValid(moldId)) {
        validMoldId = new mongoose.Types.ObjectId(moldId);
      } else {
        return res.status(400).json({ message: 'Invalid mold ID specified' });
      }
    }
    
    // Find production record
    let productionRecord = await ProductionRecord.findOne({
      machineId,
      startTime: {
        $gte: new Date(date + 'T00:00:00.000Z'),
        $lt: new Date(date + 'T23:59:59.999Z')
      }
    });

    if (!productionRecord) {
      productionRecord = new ProductionRecord({
        machineId,
        startTime: new Date(date + 'T00:00:00.000Z'),
        hourlyData: []
      });
    }

    // Get shift configuration
    const config = await Config.findOne();
    const shifts = config?.shifts || [];
    
    // Determine hours to update
    let hoursToUpdate = [hour];
    if (applyToShift) {
      // Find shift that contains the current hour
      const shift = shifts.find(s => {
        const startHour = parseInt(s.startTime.split(':')[0]);
        const endHour = parseInt(s.endTime.split(':')[0]);
        
        if (startHour <= endHour) {
          return hour >= startHour && hour < endHour;
        } else {
          return hour >= startHour || hour < endHour;
        }
      });

      if (applyToShift && shift) {
        const startHour = parseInt(shift.startTime.split(':')[0]);
        const endHour = parseInt(shift.endTime.split(':')[0]);
        
        hoursToUpdate = [];
        
        if (startHour <= endHour) {
          for (let h = startHour; h < endHour; h++) {
            hoursToUpdate.push(h);
          }
        } else {
          // Night shift (crosses midnight)
          if (hour >= startHour) {
            // First part (current day)
            for (let h = startHour; h < 24; h++) {
              hoursToUpdate.push(h);
            }
          } else if (hour < endHour) {
            // Second part (current day)
            for (let h = 0; h < endHour; h++) {
              hoursToUpdate.push(h);
            }
          }
        }
      }
    }

    // Permission check for operators
    if (req.user.role === 'operator') {
      const currentUserId = req.user._id.toString();
      
      // Operators can only assign themselves
      if (validOperatorId && validOperatorId.toString() !== currentUserId) {
        return res.status(403).json({ message: 'Operators can only assign themselves' });
      }
    }

    for (const targetHour of hoursToUpdate) {
      let hourData = productionRecord.hourlyData.find(h => h.hour === targetHour);
      
      if (!hourData) {
        // Create new entry
        hourData = {
          hour: targetHour,
          unitsProduced: 0,
          defectiveUnits: 0,
          status: 'inactive',
          runningMinutes: 0,
          stoppageMinutes: 0,
          stoppages: []
        };
        
        // Set assignments for new entry
        if (validOperatorId !== undefined) {
          hourData.operatorId = validOperatorId;
        }
        
        if (validMoldId !== undefined) {
          hourData.moldId = validMoldId;
        }
        
        if (targetHour === hour && defectiveUnits !== undefined) {
          hourData.defectiveUnits = defectiveUnits;
        }
        
        productionRecord.hourlyData.push(hourData);
      } else {
        // Update existing entry
        if (validOperatorId !== undefined) {
          hourData.operatorId = validOperatorId;
        } else {
          // Unassign operator by removing the field
          hourData.operatorId = undefined;
          delete hourData.operatorId;
        }
        
        if (validMoldId !== undefined) {
          hourData.moldId = validMoldId;
        } else {
          // Unassign mold by removing the field
          hourData.moldId = undefined;
          delete hourData.moldId;
        }
        
        if (targetHour === hour && defectiveUnits !== undefined) {
          hourData.defectiveUnits = defectiveUnits;
        }
      }
    }

    // Mark document as modified
    productionRecord.markModified('hourlyData');

    // Update total units produced
    productionRecord.unitsProduced = productionRecord.hourlyData.reduce(
      (sum, h) => sum + (h.unitsProduced || 0), 
      0
    );

    productionRecord.defectiveUnits = productionRecord.hourlyData.reduce(
      (sum, h) => sum + (h.defectiveUnits || 0), 
      0
    );

    // Save the production record
    await productionRecord.save();

    // Emit socket event
    io.emit('production-assignment-updated', {
      machineId,
      hours: hoursToUpdate,
      date,
      operatorId: validOperatorId || null,
      moldId: validMoldId || null,
      originalHour: hour,
      defectiveUnits: hour === hour ? defectiveUnits : undefined,
      timestamp: new Date()
    });

    res.json({ message: 'Production assignment updated successfully' });
  } catch (error) {
    console.error('Error saving assignment:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get machine statistics with custom timeframe
router.get('/machine-stats/:machineId', auth, async (req, res) => {
  try {
    const { machineId } = req.params;
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ message: 'Both startDate and endDate are required' });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    // Lean permission check
    const machine = await Machine.findById(machineId)
      .select('departmentId status')
      .populate('departmentId', '_id')
      .lean();
      
    if (!machine) return res.status(404).json({ message: 'Machine not found' });

    if (req.user.role === 'operator' && 
        req.user.departmentId?._id.toString() !== machine.departmentId._id.toString()) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const stats = await calculateMachineStats(machineId, start, end);
    res.json({ ...stats, currentStatus: machine.status });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Get department statistics
router.get('/department-stats/:departmentId', auth, async (req, res) => {
  try {
    const { departmentId } = req.params;
    
    // Permission check
    if (req.user.role === 'operator' && req.user.departmentId?._id.toString() !== departmentId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Get machine IDs
    const machines = await Machine.find(
      { departmentId, isActive: true }, 
      '_id'
    ).lean();

    // Get date range for last 24 hours
    const endDate = new Date();
    const startDate = new Date(endDate);
    startDate.setUTCDate(startDate.getUTCDate() - 1);

    // Parallel stats calculation
    const statsPromises = machines.map(machine => 
      calculateMachineStats(machine._id, startDate, endDate)
        .then(stats => stats.oee)
        .catch(() => 0)
    );

    const oeeValues = await Promise.all(statsPromises);
    const validOEEs = oeeValues.filter(oee => oee > 0);
    const avgOEE = validOEEs.length > 0 
      ? Math.round(validOEEs.reduce((sum, oee) => sum + oee, 0) / validOEEs.length) 
      : 0;

    res.json({ avgOEE });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Factory statistics
router.get('/factory-stats', auth, async (req, res) => {
  try {
    const machines = await Machine.find({ isActive: true }).lean();
    const machineIds = machines.map(m => m._id);

    // Get date range for last 24 hours
    const endDate = new Date();
    const startDate = new Date(endDate);
    startDate.setUTCDate(startDate.getUTCDate() - 1);

    // Get stats for all machines in parallel
    const statsPromises = machineIds.map(machineId => 
      calculateMachineStats(machineId, startDate, endDate).catch(() => null)
    );
    
    const allStats = await Promise.all(statsPromises);
    
    // Calculate totals
    let totalUnits = 0;
    let totalOEE = 0;
    let activeMachines = 0;
    let validOEEs = 0;
    
    allStats.forEach((stats, index) => {
      if (stats) {
        totalUnits += stats.totalUnitsProduced;
        if (stats.oee > 0) {
          totalOEE += stats.oee;
          validOEEs++;
        }
        if (machines[index].status === 'running') {
          activeMachines++;
        }
      }
    });

    // Get unclassified stoppages
    const unclassifiedData = await ProductionRecord.aggregate([
      {
        $match: {
          "hourlyData.stoppages": {
            $elemMatch: { reason: "unclassified" }
          }
        }
      },
      {
        $project: {
          count: {
            $size: {
              $filter: {
                input: "$hourlyData.stoppages",
                as: "s",
                cond: { $eq: ["$$s.reason", "unclassified"] }
              }
            }
          }
        }
      }
    ]);

    const unclassifiedStoppages = unclassifiedData.reduce((sum, doc) => sum + doc.count, 0);

    res.json({
      totalUnits,
      avgOEE: validOEEs > 0 ? Math.round(totalOEE / validOEEs) : 0,
      unclassifiedStoppages,
      activeMachines
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;