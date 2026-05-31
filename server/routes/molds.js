const express = require('express');
const Mold = require('../models/Mold');
const { auth, adminAuth } = require('../middleware/auth');
const { safeSearchRegex } = require('../utils/sanitize');

const router = express.Router();

// Get all molds
router.get('/', auth, async (req, res) => {
  try {
    let query = { isActive: true };
    
    if (req.user.role === 'operator' && req.user.departmentId) {
      query.departmentId = req.user.departmentId._id;
    }

    const molds = await Mold.find(query).populate('departmentId').lean();
    res.json(molds);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Get paginated molds for admin
router.get('/admin/all', auth, adminAuth, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search = '',
      department = '',
      isActive = '',
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    // Convert page and limit to numbers
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Build aggregation pipeline
    let pipeline = [];
    let matchStage = {};

    // Text search across name, description (escaped to prevent NoSQL/ReDoS injection)
    const searchRegex = safeSearchRegex(search);
    if (searchRegex) {
      matchStage.$or = [
        { name: searchRegex },
        { description: searchRegex }
      ];
    }

    // Filter by department
    if (department.trim()) {
      matchStage.departmentId = new mongoose.Types.ObjectId(department);
    }

    // Filter by active status
    if (isActive !== '') {
      matchStage.isActive = isActive === 'true';
    }

    pipeline.push({ $match: matchStage });

    // Lookup department data
    pipeline.push({
      $lookup: {
        from: 'departments',
        localField: 'departmentId',
        foreignField: '_id',
        as: 'departmentId'
      }
    });
    
    pipeline.push({ $unwind: '$departmentId' });

    // Build sort object
    const sortObj = {};
    sortObj[sortBy] = sortOrder === 'asc' ? 1 : -1;

    // Add sort
    pipeline.push({ $sort: sortObj });
    
    // Get total count before pagination
    const countPipeline = [...pipeline, { $count: "total" }];
    
    // Add pagination
    pipeline.push({ $skip: skip });
    pipeline.push({ $limit: limitNum });

    const [molds, totalResult] = await Promise.all([
      Mold.aggregate(pipeline),
      Mold.aggregate(countPipeline)
    ]);

    const totalMolds = totalResult[0]?.total || 0;

    // Calculate pagination info
    const totalPages = Math.ceil(totalMolds / limitNum);
    const hasNextPage = pageNum < totalPages;
    const hasPrevPage = pageNum > 1;

    res.json({
      molds,
      pagination: {
        currentPage: pageNum,
        totalPages,
        totalMolds,
        limit: limitNum,
        hasNextPage,
        hasPrevPage,
        nextPage: hasNextPage ? pageNum + 1 : null,
        prevPage: hasPrevPage ? pageNum - 1 : null
      },
      filters: {
        search,
        department,
        isActive,
        sortBy,
        sortOrder
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Create mold (Admin only)
router.post('/', auth, adminAuth, async (req, res) => {
  try {
    const mold = new Mold(req.body);
    await mold.save();
    res.status(201).json(mold);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Update mold (Admin only)
router.put('/:id', auth, adminAuth, async (req, res) => {
  try {
    const mold = await Mold.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    ).populate('departmentId');
    
    if (!mold) {
      return res.status(404).json({ message: 'Mold not found' });
    }
    
    res.json(mold);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete mold (Admin only) - hard delete
router.delete('/:id', auth, adminAuth, async (req, res) => {
  try {
    const mold = await Mold.findByIdAndDelete(req.params.id);
    if (!mold) {
      return res.status(404).json({ message: 'Mold not found' });
    }
    res.json({ message: 'Mold deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Toggle mold active status
router.patch('/:id/status', auth, adminAuth, async (req, res) => {
  try {
    const mold = await Mold.findById(req.params.id);
    if (!mold) {
      return res.status(404).json({ message: 'Mold not found' });
    }

    mold.isActive = !mold.isActive;
    await mold.save();

    res.json({ 
      message: `Mold ${mold.isActive ? 'activated' : 'deactivated'} successfully`,
      mold
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;