import { Link } from "react-router";
import { preloadAgentExperience } from "./agentExperiencePreload";
import { accountRouteIntent } from "./accountRoutePreload";
import { mainNavigation, pathForSurface, type MainSurface } from "./navigation";

/** The Nanocodex app mark shared by the homepage, agents and account chrome. */
export function NanocodexMark() {
  return (
    <svg className="nanocodex-mark" aria-hidden="true" viewBox="76 76 872 872">
      <rect x="76" y="76" width="872" height="872" rx="194" fill="#292929" />
      <path d="M326 695V332L638 695V332" fill="none" stroke="#f7f7f7" strokeWidth="67" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="742" cy="691" r="27" fill="#8cb38c" />
    </svg>
  );
}

/**
 * The main app's only product navigation: Home, Agents and Account. Every
 * surface renders these same three links so the chrome stays consistent.
 */
export function MainNavigationLinks({ current, className }: { current: MainSurface; className?: string }) {
  return (
    <nav className={className ? `main-navigation ${className}` : "main-navigation"} aria-label="Main navigation">
      {mainNavigation.map((item) => (
        <Link
          key={item.surface}
          to={pathForSurface(item.surface)}
          aria-current={current === item.surface ? "page" : undefined}
          className={current === item.surface ? "is-active" : undefined}
          {...(item.surface === "agent"
            ? { onFocus: preloadAgentExperience, onPointerEnter: preloadAgentExperience, onPointerDown: preloadAgentExperience }
            : item.surface === "connect" ? accountRouteIntent : {})}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
