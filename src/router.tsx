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
const LibraryPage = lazy(() => import("./screens/LibraryPage"));
const LibraryItemPage = lazy(() => import("./screens/LibraryItemPage"));
const PersonPage = lazy(() => import("./screens/PersonPage"));
const InstitutionPage = lazy(() => import("./screens/InstitutionPage"));

function screen(node: ReactNode) {
  return <Suspense fallback={null}>{node}</Suspense>;
}

/**
 * Every screen has an address:
 * - `/`: the book's front (reopens the last page)
 * - `/page/:id`: a page, `#blk_…` scrolls to one of its blocks
 * - `/page/:id/history`: the page as it was
 * - `/library`, `/library/:id`: the papers and books, and one of them
 * - `/library/people/:id`, `/library/institutions/:id`: a person, an institution
 * - `/settings`, `/sync`, `/costs`
 */
export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: screen(<HomePage />) },
      { path: "/page/:id", element: screen(<PagePage />) },
      { path: "/page/:id/history", element: screen(<HistoryPage />) },
      { path: "/library", element: screen(<LibraryPage />) },
      { path: "/library/:id", element: screen(<LibraryItemPage />) },
      { path: "/library/people/:id", element: screen(<PersonPage />) },
      { path: "/library/institutions/:id", element: screen(<InstitutionPage />) },
      { path: "/settings", element: screen(<SettingsPage />) },
      { path: "/sync", element: screen(<SyncPage />) },
      { path: "/costs", element: screen(<CostsPage />) },
    ],
  },
]);
