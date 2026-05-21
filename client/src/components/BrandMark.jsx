/**
 * Single source of truth for the TradePro wordmark/logo block.
 * Used across all auth-flow pages (Login, Register, ForgotPassword,
 * ResetPassword, VerifyEmail) so the brand never visually drifts.
 */
export default function BrandMark({ size = 'md', wordmark = true }) {
  const dims = size === 'lg' ? 'w-12 h-12 text-2xl' : 'w-11 h-11 text-xl';
  return (
    <div className="inline-flex items-center gap-2.5 font-extrabold text-white tracking-tight">
      <span
        className={`${dims} rounded-md flex items-center justify-center font-extrabold text-bg-dark`}
        style={{ background: 'linear-gradient(135deg, #FFE74D 0%, #FCD535 100%)' }}
      >
        T
      </span>
      {wordmark && <span className="text-2xl">TradePro</span>}
    </div>
  );
}
