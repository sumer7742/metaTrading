import { Link } from 'react-router-dom';

/**
 * Reusable placeholder for modules from the spec that are roadmapped for Phase 2/3:
 * Reports detail pages, Funds detail, Copy Trading, PAMM, MAM, IB Room, Bonuses, Helpdesk, Feedback, Download.
 */
export default function ComingSoon({ title, description, phase = 'Phase 2' }) {
  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="max-w-md text-center space-y-5">
        <div className="w-20 h-20 mx-auto rounded-2xl bg-teal-accent/10 border border-teal-accent/30 flex items-center justify-center">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-teal-accent">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </div>
        <div>
          <div className="inline-block px-3 py-1 rounded-full bg-teal-accent/10 text-teal-accent text-xs font-semibold border border-teal-accent/30 mb-3">
            {phase}
          </div>
          <h1 className="text-2xl font-bold text-white">{title}</h1>
          <p className="text-gray-400 mt-2 text-sm">{description}</p>
        </div>
        <Link to="/dashboard" className="btn-primary inline-flex">
          Back to Dashboard
        </Link>
      </div>
    </div>
  );
}
