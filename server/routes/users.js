const express = require('express');
const User = require('../models/User');
const { auth, adminAuth } = require('../middleware/auth');
const { safeSearchRegex } = require('../utils/sanitize');

const router = express.Router();

// Get all users without pagination and search
router.get('/', auth, async (req, res) => {
  try {
    let query = { isActive: true };
    
    // Operators only see users in their department
    if (req.user.role === 'operator' && req.user.departmentId) {
      query.departmentId = req.user.departmentId;
    }

    const users = await User.find(query)
      .populate('departmentId', 'name _id')
      .select('-password')
      .lean();

    res.json(users);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all users with pagination and search (Admin only)
router.get('/admin/all', auth, adminAuth, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search = '',
      role = '',
      department = '',
      isActive = '',
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    // Convert page and limit to numbers
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Build search query
    let query = {};

    // Text search across username, email (escaped to prevent NoSQL/ReDoS injection)
    const searchRegex = safeSearchRegex(search);
    if (searchRegex) {
      query.$or = [
        { username: searchRegex },
        { email: searchRegex }
      ];
    }

    // Filter by role
    if (role.trim()) {
      query.role = role;
    }

    // Filter by department (for operators)
    if (department.trim()) {
      query.departmentId = department;
    }

    // Filter by active status
    if (isActive !== '') {
      query.isActive = isActive === 'true';
    }

    // Build sort object
    const sortObj = {};
    sortObj[sortBy] = sortOrder === 'asc' ? 1 : -1;

    // Execute queries
    const [users, totalUsers] = await Promise.all([
      User.find(query)
        .populate('departmentId', 'name _id')
        .select('-password')
        .sort(sortObj)
        .skip(skip)
        .limit(limitNum)
        .lean(),
      User.countDocuments(query)
    ]);

    // Calculate pagination info
    const totalPages = Math.ceil(totalUsers / limitNum);
    const hasNextPage = pageNum < totalPages;
    const hasPrevPage = pageNum > 1;

    res.json({
      users,
      pagination: {
        currentPage: pageNum,
        totalPages,
        totalUsers,
        limit: limitNum,
        hasNextPage,
        hasPrevPage,
        nextPage: hasNextPage ? pageNum + 1 : null,
        prevPage: hasPrevPage ? pageNum - 1 : null
      },
      filters: {
        search,
        role,
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

// Create user (Admin only)
router.post('/', auth, adminAuth, async (req, res) => {
  try {
    const { role, departmentId } = req.body;
    
    // Validate department for operators
    if (role === 'operator' && !departmentId) {
      return res.status(400).json({ message: 'Department is required for operators' });
    }
    
    // Remove departmentId for non-operators
    const userData = {
      ...req.body,
      departmentId: role === 'operator' ? departmentId : undefined
    };

    const user = new User(userData);
    await user.save();
    
    // Return user without password
    const userWithoutPassword = user.toObject();
    delete userWithoutPassword.password;
    
    res.status(201).json(userWithoutPassword);
  } catch (error) {
    let message = 'Server error';
    
    if (error.code === 11000) {
      if (error.keyPattern.username) {
        message = 'Username already exists';
      } else if (error.keyPattern.email) {
        message = 'Email already exists';
      }
    }
    
    res.status(500).json({ message });
  }
});

// Update user (Admin only)
router.put('/:id', auth, adminAuth, async (req, res) => {
  try {
    // Prevent admin from deactivating their own account or other admin accounts
    if (req.body.isActive === false) {
      const targetUser = await User.findById(req.params.id);
      if (!targetUser) {
        return res.status(404).json({ message: 'User not found' });
      }
      
      // Check if trying to deactivate own account
      if (targetUser._id.toString() === req.user._id.toString()) {
        return res.status(400).json({ message: 'You cannot deactivate your own account' });
      }
      
      // Check if trying to deactivate another admin account
      if (targetUser.role === 'admin') {
        return res.status(400).json({ message: 'You cannot deactivate other admin accounts' });
      }
    }
    
    const { password, ...updateData } = req.body;
    
    // Find user and update
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Update only provided fields
    if (updateData.username !== undefined) user.username = updateData.username;
    if (updateData.email !== undefined) user.email = updateData.email;
    if (updateData.role !== undefined) {
      user.role = updateData.role;
      // Clear department for non-operators
      if (updateData.role !== 'operator') {
        user.departmentId = undefined;
      }
    }
    if (updateData.departmentId !== undefined) user.departmentId = updateData.departmentId;
    if (updateData.isActive !== undefined) user.isActive = updateData.isActive;

    // Only update password if provided
    if (password && password.trim() !== '') {
      user.password = password;
    }

    const updatedUser = await user.save();
    
    // Return user without password
    const userWithoutPassword = updatedUser.toObject();
    delete userWithoutPassword.password;
    res.json(userWithoutPassword);
    
  } catch (error) {
    let message = 'Server error';
    
    if (error.code === 11000) {
      if (error.keyPattern.username) {
        message = 'Username already exists';
      } else if (error.keyPattern.email) {
        message = 'Email already exists';
      }
    }
    
    res.status(500).json({ message });
  }
});

// Delete user (Admin only)
router.delete('/:id', auth, adminAuth, async (req, res) => {
  try {
    
    if (req.params.id === req.user._id.toString()) {
      return res.status(400).json({ message: 'You cannot delete your own account' });
    }
    
    const user = await User.findByIdAndDelete(req.params.id);
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;