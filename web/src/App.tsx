import { BrowserRouter, Routes, Route, Navigate } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/query-client";
import { AuthLayout } from "@/components/layouts/AuthLayout";
import { ProtectedRoute } from "@/components/layouts/ProtectedRoute";
import { ProjectLayout } from "@/components/layouts/ProjectLayout";
import { LoginPage } from "@/pages/LoginPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { ProjectPage } from "@/pages/ProjectPage";
import { FilesPage } from "@/pages/FilesPage";
import { TasksPage } from "@/pages/TasksPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { SkillsPage } from "@/pages/SkillsPage";
import { HelpPage } from "@/pages/HelpPage";
import { AccountPage } from "@/pages/AccountPage";
import { AdminPage } from "@/pages/AdminPage";
import { SetupPage } from "@/pages/SetupPage";
import { DesktopSetupPage } from "@/pages/DesktopSetupPage";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./index.css";

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={0}>
      <BrowserRouter>
        <Routes>
          {/* Public routes */}
          <Route path="/setup/desktop" element={<DesktopSetupPage />} />
          <Route element={<AuthLayout />}>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/setup" element={<SetupPage />} />
          </Route>

          {/* Protected routes */}
          <Route element={<ProtectedRoute />}>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/account" element={<AccountPage />} />
            <Route path="/help" element={<HelpPage />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="/projects/:projectId" element={<ProjectLayout />}>
              <Route index element={<ProjectPage />} />
              <Route path="c/:chatId" element={<ProjectPage />} />
              <Route path="files" element={<FilesPage />} />
              <Route path="tasks" element={<TasksPage />} />
              <Route path="skills" element={<SkillsPage />} />
              <Route path="settings" element={<SettingsPage />} />
            </Route>
          </Route>

          {/* Catch-all */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
