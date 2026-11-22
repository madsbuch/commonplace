import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import "katex/dist/katex.min.css";
// Spec: APP-6
import "@fontsource-variable/literata";
import "@fontsource-variable/literata/wght-italic.css";
import "@fontsource-variable/inter";
import { router } from "./router";
import { installTheme, useColorScheme } from "./lib/theme";
import "./lib/syncBoot";
import "./App.css";

// Before the first render, so a pinned theme never flashes the other one.
installTheme();

/** Mantine (and BlockNote's menus with it) in the app's theme, not its own guess. */
function Themed(props: { children: ReactNode }) {
  const scheme = useColorScheme();
  return (
    <MantineProvider forceColorScheme={scheme} theme={{ fontFamily: "var(--font-ui)", primaryColor: "orange" }}>
      {props.children}
    </MantineProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <Themed>
      <RouterProvider router={router} />
    </Themed>
  </StrictMode>,
);
