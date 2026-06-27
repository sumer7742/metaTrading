/**
 * Shared password policy — single source of truth for both the OTP reset flow
 * and the authenticated change-password flow (and any future signup hardening).
 *
 * Rules: 8+ chars with an uppercase, lowercase, number and special character.
 * Returns null when valid, or a short user-facing message describing the gap.
 */
function validatePasswordStrength(pw) {
  if (!pw || pw.length < 8) return 'Password must be at least 8 characters';
  if (pw.length > 128) return 'Password is too long';
  if (!/[A-Z]/.test(pw)) return 'Add at least one uppercase letter';
  if (!/[a-z]/.test(pw)) return 'Add at least one lowercase letter';
  if (!/[0-9]/.test(pw)) return 'Add at least one number';
  if (!/[^A-Za-z0-9]/.test(pw)) return 'Add at least one special character';
  return null;
}

module.exports = { validatePasswordStrength };
