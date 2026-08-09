// Entry point for the v2 page — now served at `/` (index.html), with `/arena.html` kept as an alias
// of the same page so links shared while it was being built still resolve. The original app moved to
// `/legacy.html`. Deliberately does NOT import src/index.css or
// src/App.css — v2 is styled entirely by styles/base.css plus its own component CSS, so nothing the
// old app's stylesheets do can leak in here (or vice versa).

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { bootPaper } from "./styles/paper.ts";
import "./styles/base.css";

const host = document.getElementById("v2-root");
if (!host) throw new Error("v2: #v2-root missing from the host page");

// BEFORE the first render, and before anything can paint. A `?theme=` link's whole job is that the
// person who opens it sees what the person who sent it saw; resolving the sheet inside a component
// effect would show them a white page first and repaint it a beat later, which reads as a bug in the
// page rather than as a colour someone chose. Nothing below the root ever needs to know this ran —
// the sheet is a set of custom properties on `:root` by the time React exists.
bootPaper();

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
