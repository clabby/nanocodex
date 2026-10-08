import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { HomeLanding } from "./HomeLanding";
import { loadAgentExperience } from "./agentExperiencePreload";
import { lockDocumentScroll } from "./modalBoundary";
import { visualViewportKeyboardInset } from "./mobileInteraction";
import { RouteErrorBoundary } from "./RouteErrorBoundary";
import {
  agentIdFromPath,
  isMainSurface,
  legacyRedirectPath,
  pathForAgent,
  surfaceFromUrl,
  type MainSurface,
} from "./navigation";

export type Theme = "light" | "dark";

const AgentExperience = lazy(() => loadAgentExperience().then((module) => ({ default: module.AgentExperience })));
const DeviceConnect = lazy(() => import("./DeviceConnect").then((module) => ({ default: module.DeviceConnect })));

const titles: Record<MainSurface, string> = {
  home: "Nanocodex · agents connected to your accounts",
  agent: "Agents · Nanocodex",
  connect: "Account · Nanocodex",
};

function initialTheme(): Theme {
  const stored = localStorage.getItem("nanocodex-theme");
  return stored === "light" || stored === "dark"
    ? stored
    : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#212121" : "#ffffff");
}

/**
 * The main Nanocodex app: Home, Agents and Account only. Retired surfaces
 * (docs, evals, git, demos) redirect to the homepage; their modules stay in
 * the repository but are no longer imported by the app bundle.
 */
export function MainApp() {
  const location = useLocation();
  const navigate = useNavigate();
  const [theme, setTheme] = useState<Theme>(() => {
    const initial = initialTheme();
    applyTheme(initial);
    return initial;
  });
  const resolved = surfaceFromUrl({
    pathname: location.pathname,
    searchParams: new URLSearchParams(location.search),
  });
  const surface: MainSurface = isMainSurface(resolved) ? resolved : "home";
  const routeAgentId = surface === "agent" ? agentIdFromPath(location.pathname) : undefined;
  const legacyDestination = legacyRedirectPath(location);
  // Superseded paths render their current surface and are rewritten in
  // place, so in-app links and OAuth callbacks never remount it.
  useLayoutEffect(() => {
    if (legacyDestination) navigate(legacyDestination, { replace: true, state: location.state });
  }, [legacyDestination, location.state, navigate]);

  // Keep the agent workspace alive after first visit so returning is instant.
  const [agentMounted, setAgentMounted] = useState(surface === "agent");
  useEffect(() => {
    if (surface === "agent") setAgentMounted(true);
  }, [surface]);

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem("nanocodex-theme", theme);
  }, [theme]);

  useEffect(() => {
    document.title = titles[surface];
  }, [surface]);

  const handleAgentChange = useCallback((agentId: string, options?: { replace?: boolean }) => {
    if (surface !== "agent") return;
    const destination = pathForAgent(agentId);
    if (location.pathname === destination && !location.search) return;
    navigate(destination, { replace: options?.replace });
  }, [location.pathname, location.search, navigate, surface]);

  const shellRef = useRef<HTMLDivElement>(null);
  useAgentViewportLock(surface === "agent", shellRef);

  return (
    <div className={`site-shell main-app surface-${surface}`} ref={shellRef}>
      <main id="top">
        <RouteErrorBoundary surface="agent">
          {surface === "agent" || agentMounted ? (
            <section
              className={surface === "agent" ? "home-page is-agent" : "home-page is-stashed"}
              hidden={surface !== "agent"}
              inert={surface !== "agent" ? true : undefined}
              aria-hidden={surface !== "agent"}
              aria-labelledby="agent-page-title"
            >
              <article className="home-article">
                <h1 className="sr-only" id="agent-page-title">Your Nanocodex agents</h1>
                <section className="home-demo" id="agent-demo">
                  <Suspense fallback={surface === "agent" ? <p role="status">Loading agents…</p> : null}>
                    <AgentExperience
                      theme={theme}
                      onThemeChange={setTheme}
                      agentId={routeAgentId}
                      landing={false}
                      mode={surface === "agent" ? "full" : "hidden"}
                      onAgentChange={handleAgentChange}
                    />
                  </Suspense>
                </section>
              </article>
            </section>
          ) : null}
        </RouteErrorBoundary>
        {surface === "agent" ? null : (
          <RouteErrorBoundary key={surface} surface={surface}>
            <Suspense fallback={<p role="status">Loading…</p>}>
              {surface === "home"
                ? <HomeLanding theme={theme} onThemeChange={setTheme} />
                : <DeviceConnect theme={theme} onThemeChange={setTheme} />}
            </Suspense>
          </RouteErrorBoundary>
        )}
      </main>
    </div>
  );
}

/** Pin the chat workspace to the visual viewport while the agent surface is active. */
function useAgentViewportLock(active: boolean, shellRef: React.RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    const body = document.body;
    const agentSurface = shellRef.current;
    const viewport = window.visualViewport;
    const roots = [root, body] as const;
    const alreadyLocked = roots.map((element) => element.classList.contains("agent-viewport-locked"));
    roots.forEach((element) => element.classList.add("agent-viewport-locked"));
    window.scrollTo(0, 0);
    const restoreScroll = lockDocumentScroll(root, body);
    const isComposerTarget = (target: EventTarget | null) =>
      target instanceof Element
      && agentSurface?.contains(target)
      && target.matches(".agent-touch-composer textarea");
    let keyboardTracking = isComposerTarget(document.activeElement);
    let appliedKeyboardInset: number | undefined;
    const anchorViewport = () => {
      if (!agentSurface?.isConnected || !viewport) return;
      const keyboardInset = keyboardTracking && Math.abs(viewport.scale - 1) < 0.01
        ? visualViewportKeyboardInset({
          baselineHeight: agentSurface.clientHeight,
          viewportHeight: viewport.height,
          viewportOffsetTop: viewport.offsetTop,
        })
        : 0;
      if (!isComposerTarget(document.activeElement) && keyboardInset === 0) keyboardTracking = false;
      if (appliedKeyboardInset !== keyboardInset) {
        appliedKeyboardInset = keyboardInset;
        agentSurface.style.setProperty("--terminal-keyboard-inset", `${keyboardInset}px`);
      }
    };
    const trackComposerFocus = (event: FocusEvent) => {
      if (isComposerTarget(event.target)) keyboardTracking = true;
      anchorViewport();
    };
    anchorViewport();
    viewport?.addEventListener("resize", anchorViewport);
    viewport?.addEventListener("scroll", anchorViewport);
    window.addEventListener("resize", anchorViewport);
    document.addEventListener("focusin", trackComposerFocus);
    document.addEventListener("focusout", trackComposerFocus);
    return () => {
      viewport?.removeEventListener("resize", anchorViewport);
      viewport?.removeEventListener("scroll", anchorViewport);
      window.removeEventListener("resize", anchorViewport);
      document.removeEventListener("focusin", trackComposerFocus);
      document.removeEventListener("focusout", trackComposerFocus);
      agentSurface?.style.removeProperty("--terminal-keyboard-inset");
      restoreScroll();
      roots.forEach((element, index) => {
        if (!alreadyLocked[index]) element.classList.remove("agent-viewport-locked");
      });
    };
  }, [active, shellRef]);
}
