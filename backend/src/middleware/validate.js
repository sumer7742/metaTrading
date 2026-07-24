/**
 * Generic zod request validator.
 *
 * Additive middleware — nothing existing uses or is changed by it.
 *
 *   router.post('/', validate(schemas.placeOrder), controller.place)
 *
 * The PARSED value replaces the source (`req.body`/`req.query`/`req.params`),
 * so controllers work with coerced, defaulted, trimmed data and never re-read
 * the raw input. Failures come back in the platform's standard error envelope
 * with a per-field breakdown the frontend can attach to inputs.
 */

const { AppError } = require('../utils/errors');

const SOURCES = ['body', 'query', 'params'];

/**
 * @param {import('zod').ZodTypeAny} schema
 * @param {'body'|'query'|'params'} [source='body']
 */
const validate = (schema, source = 'body') => (req, res, next) => {
  if (!SOURCES.includes(source)) return next(new Error(`validate(): unknown source "${source}"`));

  const result = schema.safeParse(req[source]);
  if (result.success) {
    // Express 5 makes req.query a getter — assign defensively so this
    // middleware works on both Express 4 and 5.
    try {
      req[source] = result.data;
    } catch (_) {
      Object.defineProperty(req, source, { value: result.data, writable: true, configurable: true });
    }
    return next();
  }

  const issues = result.error.issues || [];
  const fields = issues.map((i) => ({
    field: i.path.join('.') || source,
    message: i.message,
    code: i.code,
  }));

  return next(new AppError(
    fields.length ? `${fields[0].field}: ${fields[0].message}` : 'Invalid request',
    400,
    'VALIDATION_ERROR',
    { fields }
  ));
};

module.exports = validate;
module.exports.validate = validate;
