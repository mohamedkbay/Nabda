/// <reference types="vite/client" />
import { createRoot } from "react-dom/client";
import { Dashboard } from "../../components/nabda/dashboard";
import "../../app/globals.css";
import "../../app/illustrated.css";

createRoot(document.getElementById("root")!).render(
  <Dashboard
    signInPath="/auth/github?return_to=%2Fdashboard"
    signInLabel="Continue with GitHub"
    signOutPath="/auth/logout"
    websiteOrigin={import.meta.env.VITE_NABDA_WEBSITE_ORIGIN}
  />,
);
