import type React from "react";
import { Link, Outlet, useLocation } from "react-router";
import { useAuthStore } from "@/stores/auth";
import { useCurrentUser } from "@/api/admin";
import {
  FolderIcon,
  CircleHelpIcon,
  ShieldIcon,
  LogOutIcon,
  UserIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { InstallBanner } from "@/components/InstallBanner";
import { CreateProjectDialog } from "@/components/projects/CreateProjectDialog";
import { useState } from "react";

function SidebarContent({
  navItems,
  location,
  initials,
  user,
  isAdmin,
  logout,
  onNavigate,
  onClose,
}: {
  navItems: { to: string; icon: React.ComponentType<{ className?: string }>; label: string }[];
  location: ReturnType<typeof useLocation>;
  initials: string;
  user: { username?: string } | null;
  isAdmin?: boolean;
  logout: () => void;
  onNavigate?: () => void;
  onClose?: () => void;
}) {
  return (
    <>
      {/* Logo */}
      <div className="px-5 pt-4 pb-3 flex items-center justify-between">
        <Link to="/" className="inline-flex text-foreground" onClick={onNavigate}>
          <svg viewBox="0 0 32 32" fill="none" className="size-6" aria-label="Zero AI">
            <ellipse cx="16" cy="16" rx="13" ry="5.5" transform="rotate(-30 16 16)" stroke="currentColor" strokeWidth="1.5" opacity="0.5"/>
            <path d="M16 5.5C12.2 5.5 9.5 9.8 9.5 16c0 6.2 2.7 10.5 6.5 10.5s6.5-4.3 6.5-10.5c0-6.2-2.7-10.5-6.5-10.5z" stroke="currentColor" strokeWidth="2.2"/>
            <circle cx="16" cy="16" r="2.5" fill="currentColor" opacity="0.9"/>
            <circle cx="5.5" cy="10.5" r="1.2" fill="currentColor" opacity="0.7"/>
            <circle cx="26.5" cy="21.5" r="1.2" fill="currentColor" opacity="0.7"/>
          </svg>
        </Link>
        {onClose && (
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close menu">
            <XIcon className="size-4" />
          </Button>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 space-y-1">
        {navItems.map((item) => {
          const isActive = location.pathname === item.to;
          return (
            <Link
              key={item.to}
              to={item.to}
              onClick={onNavigate}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
              }`}
            >
              <item.icon className="size-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Install/notification banner as card above profile */}
      <div className="px-3">
        <InstallBanner variant="card" />
      </div>

      {/* Profile section at bottom */}
      <div className="px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] border-t border-border/40">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-2.5 w-full px-2 py-1.5 rounded-lg text-sm hover:bg-accent/50 transition-colors text-left">
              <Avatar className="size-7">
                <AvatarFallback className="text-[10px] bg-blue-100 text-blue-700 dark:bg-primary/10 dark:text-primary">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">
                  {user?.username || "User"}
                </p>
              </div>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="start"
            className="w-[var(--radix-dropdown-menu-trigger-width)]"
          >
            <DropdownMenuItem asChild>
              <Link to="/account" onClick={onNavigate}>
                <UserIcon />
                Settings
              </Link>
            </DropdownMenuItem>
            {isAdmin && (
              <DropdownMenuItem asChild>
                <Link to="/admin" onClick={onNavigate}>
                  <ShieldIcon />
                  Admin
                </Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem asChild>
              <Link to="/help" onClick={onNavigate}>
                <CircleHelpIcon />
                Help
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => { logout(); onNavigate?.(); }}>
              <LogOutIcon />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}

export function DashboardLayout() {
  const user = useAuthStore((s) => s.user);
  const logout = () => { void import("@/stores/auth").then((m) => m.logoutApi()); };
  const { data: currentUser } = useCurrentUser();
  const isAdmin = currentUser?.isAdmin;
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const canCreateProjects = currentUser?.canCreateProjects !== false;

  const navItems = [
    { to: "/", icon: FolderIcon, label: "Projects" },
  ];

  const initials = user?.username
    ? user.username.slice(0, 2).toUpperCase()
    : "U";

  const sidebarProps = {
    navItems,
    location,
    initials,
    user,
    isAdmin,
    logout,
  };

  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* Mobile header */}
      <header className="sticky top-0 z-40 shrink-0 h-10 flex items-center px-3 gap-2 bg-background border-b border-border/30 md:hidden">
        <Button variant="ghost" size="icon-sm" onClick={() => setMobileOpen(true)} aria-label="Open menu">
          <svg viewBox="0 0 16 16" fill="none" className="size-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <line x1="2" y1="5.5" x2="14" y2="5.5" />
            <line x1="2" y1="10.5" x2="10" y2="10.5" />
          </svg>
        </Button>
        <span className="text-sm font-semibold truncate flex-1">Projects</span>
        {canCreateProjects && <CreateProjectDialog trigger={
          <Button variant="ghost" size="icon-sm" aria-label="New project">
            <PlusIcon className="size-4" />
          </Button>
        } />}
      </header>

      {/* Mobile sidebar sheet */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-72 p-0 [&>button]:hidden">
          <SheetHeader className="sr-only">
            <SheetTitle>Navigation</SheetTitle>
            <SheetDescription>App navigation menu</SheetDescription>
          </SheetHeader>
          <div className="flex h-full flex-col">
            <SidebarContent {...sidebarProps} onNavigate={() => setMobileOpen(false)} onClose={() => setMobileOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>

      {/* Desktop sidebar */}
      <aside className="hidden md:flex flex-col w-64 border-r bg-background shrink-0">
        <SidebarContent {...sidebarProps} />
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto min-h-0">
        <Outlet />
      </main>
    </div>
  );
}
