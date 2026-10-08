import { QueryClientProvider } from "@tanstack/react-query";
import { appQueryClient } from "./queryClient";
import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { AccountSessionProvider } from "./AccountSession";
import { MainApp } from "./MainApp";
import { preloadAgentExperience } from "./agentExperiencePreload";
import { installStaleChunkRecovery } from "./staleChunkRecovery";
import "./MainNavigation.css";

const ArtifactRuntime = lazy(() => import("./artifactRuntime").then((module) => ({ default: module.ArtifactRuntime })));
const PermissionRequestPage = lazy(() => import("./PermissionRequestPage").then(module => ({ default: module.PermissionRequestPage })));
const BrowserLoginPage = lazy(() => import("./BrowserLoginPage").then(module => ({default:module.BrowserLoginPage})));
const SharedThreadView = lazy(() => import("./SharedThreadView").then((module) => ({ default: module.SharedThreadView })));
const directUrl = new URL(window.location.href);
const directPath = directUrl.pathname === "/"
  ? "/"
  : directUrl.pathname.replace(/\/+$/, "");
installStaleChunkRecovery(window);
// A direct /agents load needs the chat module before anything useful renders:
// start fetching it now instead of after React's first commit.
if (/^\/agents?(?:\/|$)/.test(directPath)) preloadAgentExperience();
const container = document.getElementById("root");
if (!container) throw new Error("Nanocodex root container is missing");

createRoot(container).render(
  directPath === "/artifact-runtime"
    ? <Suspense fallback={null}><ArtifactRuntime /></Suspense>
    : /^\/share\/[^/]+$/.test(directPath)
      ? <Suspense fallback={<p role="status">Opening shared thread…</p>}><SharedThreadView key={directPath} agentId={decodeURIComponent(directPath.slice(7))} /></Suspense>
      : <BrowserApplication url={directUrl} />,
);

function BrowserApplication({ url }: { url: URL }) {
  return (
    <QueryClientProvider client={appQueryClient}>
      <BrowserRouter useTransitions>
        <Suspense fallback={null}>
          <AccountSessionProvider>
            {url.pathname === "/" && url.searchParams.has("permission_request")
              ? <PermissionRequestPage url={url} />
              : url.pathname === "/browser-login"
                ? <BrowserLoginPage url={url} />
                : <MainApp />}
          </AccountSessionProvider>
        </Suspense>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
