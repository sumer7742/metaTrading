/**
 * Field-level validators for auth forms.
 *
 * Each validator returns `null` when the value is acceptable, or a short
 * error message string when it isn't. Designed to be cheap to call on
 * every keystroke (so inline errors can update live) and also reusable
 * inside the form's submit guard.
 *
 * Backend still validates everything — these helpers are about UX, not
 * security.
 */

// Generous but real-world email pattern. Doesn't try to match every RFC
// edge case (those break more legit addresses than they catch).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Letters (incl. accented), apostrophes, hyphens, spaces. 1–50 chars.
// Rejects digits + special chars so names like "John123" don't sneak in.
const NAME_RE = /^[\p{L}][\p{L}\s'-]{0,49}$/u;

// E.164-ish: optional leading +, then 7–15 digits. Spaces/dashes are
// stripped on type so the user can type naturally.
const PHONE_RE = /^\+?[0-9]{7,15}$/;

// 8 alphanumeric chars — matches the format we generate
// (`uuidv4().slice(0,8).toUpperCase()` produces hex chars 0–9, A–F, but
// admin-assigned codes could be wider, so allow full alphanumeric here).
const REFERRAL_RE = /^[A-Z0-9]{6,16}$/;

const TOTP_RE = /^[0-9]{6}$/;
const BACKUP_RE = /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/;

export const v = {
  email(value) {
    const s = (value || '').trim();
    if (!s) return 'Email is required';
    if (s.length > 254) return 'Email is too long';
    if (!EMAIL_RE.test(s)) return 'Enter a valid email address';
    return null;
  },

  password(value, { strict = false } = {}) {
    const s = value || '';
    if (!s) return 'Password is required';
    if (s.length < 8) return 'At least 8 characters';
    if (s.length > 128) return 'Password is too long';
    if (strict) {
      // For registration we nudge a stronger password — at least 3 of
      // the 4 character classes. Backend still accepts anything ≥ 8 so
      // this is purely UX guidance, displayed as an error before submit.
      const classes =
        (/[a-z]/.test(s) ? 1 : 0) +
        (/[A-Z]/.test(s) ? 1 : 0) +
        (/\d/.test(s)    ? 1 : 0) +
        (/[^A-Za-z0-9]/.test(s) ? 1 : 0);
      if (classes < 3) return 'Mix letters, numbers, and a symbol';
    }
    return null;
  },

  passwordConfirm(value, original) {
    if (!value) return 'Confirm your password';
    if (value !== original) return 'Passwords do not match';
    return null;
  },

  firstName(value) {
    const s = (value || '').trim();
    if (!s) return 'First name is required';
    if (!NAME_RE.test(s)) return 'Letters, hyphens, and apostrophes only';
    return null;
  },

  lastName(value) {
    const s = (value || '').trim();
    if (!s) return null; // optional
    if (!NAME_RE.test(s)) return 'Letters, hyphens, and apostrophes only';
    return null;
  },

  phone(value) {
    const s = (value || '').trim();
    if (!s) return null; // optional
    if (!PHONE_RE.test(s)) return 'Enter 7–15 digits (optional + prefix)';
    return null;
  },

  country(value) {
    const s = (value || '').trim();
    if (!s) return 'Pick a country';
    if (!/^[A-Z]{2}$/.test(s)) return 'Invalid country code';
    return null;
  },

  referralCode(value) {
    const s = (value || '').trim().toUpperCase();
    if (!s) return null; // optional
    if (!REFERRAL_RE.test(s)) return 'Letters and digits only (6–16 chars)';
    return null;
  },

  totp(value) {
    const s = (value || '').replace(/\s/g, '');
    if (!s) return 'Enter the 6-digit code';
    if (!TOTP_RE.test(s)) return 'Code must be 6 digits';
    return null;
  },

  backupCode(value) {
    const s = (value || '').trim().toUpperCase();
    if (!s) return 'Enter your backup code';
    if (!BACKUP_RE.test(s)) return 'Format: XXXX-XXXX';
    return null;
  },
};

// Sanitisers — run on the raw input value as the user types, so the
// form's internal state never holds disallowed characters.
export const sanitize = {
  // Strip whitespace + collapse to a single line; leave the @ intact.
  email: (s) => (s || '').replace(/\s+/g, '').toLowerCase().slice(0, 254),
  // Keep + as the only non-digit; strip spaces, dashes, dots.
  phone: (s) => {
    const cleaned = (s || '').replace(/[^\d+]/g, '');
    // Only allow a single leading +.
    return cleaned.startsWith('+')
      ? '+' + cleaned.slice(1).replace(/\+/g, '').slice(0, 15)
      : cleaned.replace(/\+/g, '').slice(0, 15);
  },
  // Letters / apostrophes / hyphens / spaces — strips digits + symbols.
  name: (s) => (s || '').replace(/[^\p{L}\s'-]/gu, '').slice(0, 50),
  // Uppercase alphanumeric; matches the stored format.
  referralCode: (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16),
  // Numbers only.
  totp: (s) => (s || '').replace(/\D/g, '').slice(0, 6),
  // Auto-insert the dash after 4 chars so the user can type either
  // `ABCD1234` or `ABCD-1234`.
  backupCode: (s) => {
    const raw = (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
  },
};
