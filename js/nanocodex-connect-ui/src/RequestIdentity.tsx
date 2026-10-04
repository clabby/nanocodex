/** The requester is identified from the validated Connect request, never remote artwork. */
export function RequestIdentity({ name, origin }: Readonly<{ name: string; origin?: string }>) {
  return <div className="request-identity">
    <div className="identity-marks" aria-hidden="true">
      <span className="identity-app">{name.slice(0, 1).toUpperCase()}</span>
      <span className="identity-link">↔</span>
      <span className="identity-nanocodex"><svg viewBox="76 76 872 872"><rect x="76" y="76" width="872" height="872" rx="194" fill="#292929" /><path d="M326 695V332L638 695V332" fill="none" stroke="#f7f7f7" strokeWidth="67" strokeLinecap="round" strokeLinejoin="round" /><circle cx="742" cy="691" r="27" fill="#8cb38c" /></svg></span>
    </div>
    {origin ? <span className="request-origin">{origin}</span> : null}
  </div>;
}
