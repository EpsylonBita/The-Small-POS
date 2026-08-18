import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/globals.css";
import "./styles/glassmorphism.css";

// Ensure screen capture IPC listeners are registered at startup
import "./services/ScreenCaptureHandler";

// Keep the User Timing buffer bounded. React's development build records a
// performance.measure per component render and never clears them — measured
// at 34,000+ entries (hundreds of MB of blink_gc) after an hour of dev use.
// Release builds record none, so there this clears an empty buffer for free.
// 5 minutes of history is plenty for any profiling session.
window.setInterval(() => {
  performance.clearMeasures();
  performance.clearMarks();
}, 5 * 60 * 1000);

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
