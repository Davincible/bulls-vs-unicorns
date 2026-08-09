// Entry point for the v2 page (arena.html). Deliberately does NOT import src/index.css or
// src/App.css — v2 is styled entirely by styles/base.css plus its own component CSS, so nothing the
// old app's stylesheets do can leak in here (or vice versa).

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles/base.css";

const host = document.getElementById("v2-root");
if (!host) throw new Error("v2: #v2-root missing from arena.html");

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
