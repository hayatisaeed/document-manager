import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@fontsource/vazirmatn/arabic-400.css";
import "@fontsource/vazirmatn/arabic-600.css";
import "@fontsource/vazirmatn/arabic-700.css";
import "./prefs";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
