// Small input-sanitisation helpers shared across routes.
//
// These guard against two real problems in the current routes:
//  1. NoSQL/ReDoS injection: a user-supplied `search` string was passed
//     straight into `{ $regex: search }`. A crafted value can inject regex
//     that is catastrophically slow (ReDoS) or, if the value is an object,
//     smuggle Mongo operators. We coerce to string and escape metacharacters.
//  2. Invalid ObjectIds reaching Mongoose, which throws a 500 (and leaks the
//     CastError). We validate up front and let callers return a clean 400.

const mongoose = require('mongoose');

// Escape all regex special characters so the value is treated literally.
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build a safe case-insensitive "contains" regex from untrusted input.
// Returns null when there's nothing to search for (caller should skip it).
function safeSearchRegex(value) {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  if (!str) return null;
  // Cap length to bound regex work and avoid abuse.
  return { $regex: escapeRegex(str.slice(0, 100)), $options: 'i' };
}

// True only for syntactically valid Mongo ObjectIds.
function isValidObjectId(id) {
  return typeof id === 'string' && mongoose.Types.ObjectId.isValid(id) &&
    String(new mongoose.Types.ObjectId(id)) === id;
}

module.exports = { escapeRegex, safeSearchRegex, isValidObjectId };
