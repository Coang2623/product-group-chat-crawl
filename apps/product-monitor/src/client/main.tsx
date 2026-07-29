import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { browserApi } from "./api.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

createRoot(root).render(
    <StrictMode>
        <App api={browserApi} />
    </StrictMode>,
);
