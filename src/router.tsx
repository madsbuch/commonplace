import { lazy, Suspense, type ReactNode } from "react";
import { createBrowserRouter } from "react-router-dom";
import { Layout } from "./components/Layout";

// Each screen is its own chunk, loaded when first opened.
const HomePage = lazy(() => import("./screens/HomePage"));
const PagePage = lazy(() => import("./screens/PagePage"));
const HistoryPage = lazy(() => import("./screens/HistoryPage"));
const SettingsPage = lazy(() => import("./screens/SettingsPage"));
const SyncPage = lazy(() => import("./screens/SyncPage"));
const CostsPage = lazy(() => import("./screens/CostsPage"));

function screen(node: ReactNode) {
  return <Suspense fallback={null}>{node}</Suspense>;
}

/**
 * Every screen has an address:
 * - `/`: the book's front (reopens the last page)
 * - `/page/:id`: a page, `#blk_…` scrolls to one of its blocks
 * - `/page/:id/history`: the page as it was
 * - `/settings`, `/sync`, `/costs`
 */
export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: screen(<HomePage />) },
      { path: "/page/:id", element: screen(<PagePage />) },
      { path: "/page/:id/history", element: screen(<HistoryPage />) },
      { path: "/settings", element: screen(<SettingsPage />) },
      { path: "/sync", element: screen(<SyncPage />) },
      { path: "/costs", element: screen(<CostsPage />) },
    ],
  },
]);
