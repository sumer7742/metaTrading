const { AppError } = require('../utils/errors');

const notFound = (req, res, next) => {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404, 'NOT_FOUND'));
};

const errorHandler = (err, req, res, next) => {
  // eslint-disable-line no-unused-vars
  if (err.code === 11000) {
    // Mongo duplicate key
    const field = Object.keys(err.keyPattern || {})[0] || 'field';
    return res.status(409).json({
      success: false,
      error: { message: `Duplicate value for ${field}`, code: 'DUPLICATE' },
    });
  }
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      error: { message: err.message, code: 'VALIDATION_ERROR' },
    });
  }

  const statusCode = err.statusCode || 500;
  const code = err.code || 'INTERNAL_ERROR';
  const message = err.isOperational ? err.message : 'Internal server error';

  if (statusCode >= 500) console.error('[ERROR]', err);

  res.status(statusCode).json({
    success: false,
    error: { message, code, ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }) },
  });
};

module.exports = { notFound, errorHandler };
