/// <reference path="./types/electron.d.ts" />
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/globals.css";
import "./styles/glassmorphism.css";

// Ensure screen capture IPC listeners are registered at startup
import "./services/ScreenCaptureHandler";

// Get the root element
const container = document.getElementById("root");

if (!container) {
  console.error("❌ Root element not found!");
  throw new Error("Root element not found");
}

// Create root and render the app
const root = createRoot(container);

try {
  root.render(
    <App />
  );
} catch (error) {
  console.error("❌ Error rendering component:", error);
  // Show a simple error message
  root.render(
    <div style={{ padding: '20px', textAlign: 'center' }}>
      <h1>Application Error</h1>
      <p>Failed to load the POS system. Please contact support.</p>
    </div>
  );
}
