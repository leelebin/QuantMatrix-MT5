const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { usersDb } = require('../config/db');

// User model helper functions for NeDB
const User = {
  // Create a new user (with password hashing)
  async create({ name, email, password, role }) {
    const salt = await bcrypt.genSalt(12);
    const hashedPassword = await bcrypt.hash(password, salt);

    const now = new Date();
    const user = await usersDb.insert({
      name: name.trim(),
      email: email.toLowerCase(),
      password: hashedPassword,
      role: role || 'user',
      isActive: true,
      refreshToken: undefined,
      resetPasswordToken: undefined,
      resetPasswordExpire: undefined,
      createdAt: now,
      updatedAt: now,
    });

    // Return without password
    const { password: _, ...userWithoutPassword } = user;
    return userWithoutPassword;
  },

  // Find one user by query
  async findOne(query) {
    const user = await usersDb.findOne(query);
    return user;
  },

  // Find one user by query, including password field
  async findOneWithPassword(query) {
    const user = await usersDb.findOne(query);
    return user;
  },

  // Find user by ID
  async findById(id) {
    const user = await usersDb.findOne({ _id: id });
    if (user) {
      const { password, ...userWithoutPassword } = user;
      return userWithoutPassword;
    }
    return null;
  },

  // Find user by ID with password
  async findByIdWithPassword(id) {
    return await usersDb.findOne({ _id: id });
  },

  // Update user by ID
  async findByIdAndUpdate(id, fields) {
    fields.updatedAt = new Date();
    await usersDb.update({ _id: id }, { $set: fields });
    const user = await usersDb.findOne({ _id: id });
    if (user) {
      const { password, ...userWithoutPassword } = user;
      return userWithoutPassword;
    }
    return null;
  },

  // Save/update a full user document
  async save(user) {
    user.updatedAt = new Date();
    await usersDb.update({ _id: user._id }, { $set: user });
    return user;
  },

  // Save user with password hashing if password changed
  async saveWithPasswordHash(user, newPassword) {
    const salt = await bcrypt.genSalt(12);
    user.password = await bcrypt.hash(newPassword, salt);
    user.updatedAt = new Date();
    await usersDb.update({ _id: user._id }, { $set: user });
    return user;
  },

  // Compare password
  async matchPassword(enteredPassword, hashedPassword) {
    return await bcrypt.compare(enteredPassword, hashedPassword);
  },

  // Generate password reset token
  getResetPasswordToken() {
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetPasswordToken = crypto
      .createHash('sha256')
      .update(resetToken)
      .digest('hex');
    const resetPasswordExpire = Date.now() + 10 * 60 * 1000; // 10 minutes
    return { resetToken, resetPasswordToken, resetPasswordExpire };
  },
};

module.exports = User;
