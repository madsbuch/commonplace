import { lazy, Suspense, type ReactNode } from "react";
import { createBrowserRouter, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout";

// Each screen is its own chunk, loaded when first opened.
const HomePage = lazy(() => import("./screens/HomePage"));
const PagePage = lazy(() => import("./screens/PagePage"));
const HistoryPage = lazy(() => import("./screens/HistoryPage"));
const SettingsPage = lazy(() => import("./screens/SettingsPage"));
const AiSettingsPage = lazy(() => import("./screens/AiSettingsPage"));
const LeanSettingsPage = lazy(() => import("./screens/LeanSettingsPage"));
const SyncPage = lazy(() => import("./screens/SyncPage"));
const CostsPage = lazy(() => import("./screens/CostsPage"));
const LibraryPage = lazy(() => import("./screens/LibraryPage"));
const LibraryItemPage = lazy(() => import("./screens/LibraryItemPage"));
const PersonPage = lazy(() => import("./screens/PersonPage"));
const InstitutionPage = lazy(() => import("./screens/InstitutionPage"));
const ChatsPage = lazy(() => import("./screens/ChatsPage"));
const ChatPage = lazy(() => import("./screens/ChatPage"));
const MemoryPage = lazy(() => import("./screens/MemoryPage"));
const AudioPage = lazy(() => import("./screens/AudioPage"));
const RecordingPage = lazy(() => import("./screens/RecordingPage"));

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
 * - `/chats`, `/chats/:id`, `/memory`: the assistant's chats, one chat, its memory
 * - `/audio`, `/audio/:id`: the audio library, and one recording in the player
 * - `/settings`, and nested in it `/settings/ai`, `/settings/lean`,
 *   `/settings/sync` and `/settings/costs`
 *   (`/sync` and `/costs` lead there)
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
      { path: "/chats", element: screen(<ChatsPage />) },
      { path: "/chats/:id", element: screen(<ChatPage />) },
      { path: "/memory", element: screen(<MemoryPage />) },
      // Spec: AUD-1, AUD-12
      { path: "/audio", element: screen(<AudioPage />) },
      { path: "/audio/:id", element: screen(<RecordingPage />) },
      { path: "/settings", element: screen(<SettingsPage />) },
      // Spec: APP-8
      { path: "/settings/ai", element: screen(<AiSettingsPage />) },
      { path: "/settings/lean", element: screen(<LeanSettingsPage />) },
      { path: "/settings/sync", element: screen(<SyncPage />) },
      { path: "/settings/costs", element: screen(<CostsPage />) },
      { path: "/sync", element: <Navigate to="/settings/sync" replace /> },
      { path: "/costs", element: <Navigate to="/settings/costs" replace /> },
    ],
  },
]);
