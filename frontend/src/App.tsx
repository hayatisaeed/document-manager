import { Link, Route, Routes } from "react-router-dom";
import ProjectsPage from "./pages/ProjectsPage";
import SettingsPage from "./pages/SettingsPage";
import Workspace from "./pages/Workspace";
import { ToastHost } from "./components/Toast";

export default function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<ProjectsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/p/:slug" element={<Workspace />} />
        <Route
          path="*"
          element={
            <div className="page">
              <h1>Not found</h1>
              <Link to="/">Back to projects</Link>
            </div>
          }
        />
      </Routes>
      <ToastHost />
    </>
  );
}
