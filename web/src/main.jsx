import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import DownloadPage from "./DownloadPage.jsx";
import "./styles.css";

// Simple path-based routing: /download -> download page, everything else -> panel.
const isDownload = window.location.pathname.replace(/\/+$/, "").endsWith("/download");

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>{isDownload ? <DownloadPage /> : <App />}</React.StrictMode>
);
