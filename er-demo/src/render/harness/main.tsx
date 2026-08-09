// TEMPORARY VERIFICATION HARNESS entry point — see HarnessApp.tsx's header comment for what this is
// and why it can be deleted once the real App.tsx wires PixiCanvas in. Mirrors src/main.tsx exactly
// (same StrictMode wrapper), just mounting HarnessApp instead of the real App.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HarnessApp } from "./HarnessApp.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HarnessApp />
  </StrictMode>,
);
