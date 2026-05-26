class AppError extends Error {
  constructor(message, statusCode = 400, code = 'BAD_REQUEST', details = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details; // optional structured payload for the FE
    this.isOperational = true;
  }
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const sendSuccess = (res, data, status = 200) => res.status(status).json({ success: true, data });

module.exports = { AppError, asyncHandler, sendSuccess };
