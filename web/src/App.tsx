import { BrowserRouter, Routes, Route, Navigate } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/query-client";
import { AuthLayout } from "@/components/layouts/AuthLayout";
import { ProtectedRoute } from "@/components/layouts/ProtectedRoute";
import { ProjectLayout } from "@/components/layouts/ProjectLayout";
import { LoginPage } from "@/pages/LoginPage";
import { InvitePage } from "@/pages/InvitePage";
import { DashboardPage } from "@/pages/DashboardPage";
import { DashboardLayout } from "@/components/layouts/DashboardLayout";
import { ProjectPage } from "@/pages/ProjectPage";
import { FilesPage } from "@/pages/FilesPage";
import { TasksPage } from "@/pages/TasksPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { SkillsPage } from "@/pages/SkillsPage";
import { AppsPage } from "@/pages/AppsPage";
import { HelpPage } from "@/pages/HelpPage";
import { AccountPage } from "@/pages/AccountPage";
import { AdminPage } from "@/pages/AdminPage";
import { AppGatePage } from "@/pages/AppGatePage";
import { SetupPage } from "@/pages/SetupPage";
import { PendingResponsePage } from "@/pages/PendingResponsePage";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { ThemeApplier } from "@/components/ThemeApplier";
import "./index.css";

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeApplier />
      <Toaster />
      <TooltipProvider delayDuration={0}>
      <BrowserRouter>
        <Routes>
          {/* Public routes */}
          <Route element={<AuthLayout />}>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/invite/:token" element={<InvitePage />} />
            <Route path="/setup" element={<SetupPage />} />
          </Route>

          {/* App gate - public so share links work without auth; the page itself
              uses an auth token or share token to talk to the API. */}
          <Route path="/app/:slug/*" element={<AppGatePage />} />

          {/* Protected routes */}
          <Route element={<ProtectedRoute />}>
            <Route element={<DashboardLayout />}>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/account" element={<AccountPage />} />
              <Route path="/help" element={<HelpPage />} />
              <Route path="/admin" element={<AdminPage />} />
            </Route>
            <Route path="/pending/:id" element={<PendingResponsePage />} />
            <Route path="/projects/:projectId" element={<ProjectLayout />}>
              <Route index element={<ProjectPage />} />
              <Route path="c/:chatId" element={<ProjectPage />} />
              <Route path="files" element={<FilesPage />} />
              <Route path="tasks" element={<TasksPage />} />
              <Route path="services" element={<AppsPage />} />
              <Route path="skills" element={<SkillsPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="account" element={<AccountPage />} />
              <Route path="admin" element={<AdminPage />} />
              <Route path="help" element={<HelpPage />} />
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
