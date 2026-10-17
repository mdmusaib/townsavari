// Centralized Express error handler (agent.md §2: middlewares/errorHandler.js).
// Must be registered LAST via app.use(errorHandler) so all next(err) land here.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  console.error(`[error] ${req.method} ${req.path}:`, err.message);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: status >= 500 ? 'Internal server error' : err.message,
    ...(status >= 500 ? {} : { details: err.details }),
  });
}

module.exports = errorHandler;
