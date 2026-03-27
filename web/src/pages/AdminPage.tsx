import { useState } from "react";
import { Link } from "react-router";
import { useAuthStore } from "@/stores/auth";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeftIcon,
  TrashIcon,
  KeyIcon,
  ShieldIcon,
  PlusIcon,
  EyeIcon,
  EyeOffIcon,
  LogOutIcon,
} from "lucide-react";
import {
  useAdminUsers,
  useCreateUser,
  useDeleteUser,
  useAdminSettings,
  useUpdateSettings,
} from "@/api/admin";
import { toast } from "sonner";

export function AdminPage() {
  const logout = useAuthStore((s) => s.logout);

  return (
    <div className="flex flex-col h-screen">
      <header className="shrink-0 border-b bg-background/95 backdrop-blur-sm supports-[backdrop-filter]:bg-background/60">
        <div className="flex items-center justify-between h-14 px-6 max-w-xl mx-auto w-full">
          <div className="flex items-center gap-3">
            <Link
              to="/"
              className="text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Back to projects"
            >
              <ArrowLeftIcon className="size-4" />
            </Link>
            <h1 className="text-sm font-semibold tracking-tight font-display">
              Admin
            </h1>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={logout}
            aria-label="Sign out"
          >
            <LogOutIcon className="size-4" />
          </Button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-xl mx-auto px-6 py-6 space-y-8">
          <InstanceSettingsSection />
          <UserManagementSection />
        </div>
      </main>
    </div>
  );
}

function InstanceSettingsSection() {
  const { data: settings } = useAdminSettings();
  const updateSettings = useUpdateSettings();
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [showKey, setShowKey] = useState(false);

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <KeyIcon className="size-4 text-emerald-500" />
        <h3 className="text-sm font-semibold">Instance Settings</h3>
      </div>
      <div className="rounded-lg border p-4 space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium">OpenRouter API Key</label>
          <p className="text-xs text-muted-foreground">
            Current: {settings?.OPENROUTER_API_KEY ?? "Not set"}
          </p>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                type={showKey ? "text" : "password"}
                placeholder="sk-or-..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="h-8 text-xs pr-8"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showKey ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
              </button>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={!apiKey || updateSettings.isPending}
              onClick={() => {
                updateSettings.mutate({ OPENROUTER_API_KEY: apiKey }, {
                  onSuccess: () => { setApiKey(""); toast.success("API key updated"); },
                  onError: (err) => toast.error(err.message),
                });
              }}
            >
              Update
            </Button>
          </div>
        </div>
        <div className="space-y-2 pt-2 border-t">
          <label className="text-sm font-medium">Default Model</label>
          <p className="text-xs text-muted-foreground">
            Current: {settings?.OPENROUTER_MODEL ?? "minimax/minimax-m2.5 (default)"}
          </p>
          <div className="flex gap-2">
            <Input
              placeholder="minimax/minimax-m2.5"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="h-8 text-xs flex-1"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!model || updateSettings.isPending}
              onClick={() => {
                updateSettings.mutate({ OPENROUTER_MODEL: model }, {
                  onSuccess: () => { setModel(""); toast.success("Model updated"); },
                  onError: (err) => toast.error(err.message),
                });
              }}
            >
              Update
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function UserManagementSection() {
  const { data: users } = useAdminUsers();
  const createUser = useCreateUser();
  const deleteUser = useDeleteUser();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <ShieldIcon className="size-4 text-blue-500" />
        <h3 className="text-sm font-semibold">User Management</h3>
      </div>
      <div className="rounded-lg border p-4 space-y-4">
        <div className="space-y-2">
          {users?.map((user) => (
            <div key={user.id} className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <div className="size-7 rounded-full bg-muted flex items-center justify-center text-[11px] font-semibold shrink-0">
                  {user.email.charAt(0).toUpperCase()}
                </div>
                <span className="text-xs truncate">{user.email}</span>
                {user.isAdmin && (
                  <Badge variant="outline" className="text-[10px] shrink-0">Admin</Badge>
                )}
              </div>
              {!user.isAdmin && (
                <button
                  onClick={() => {
                    deleteUser.mutate(user.id, {
                      onError: (err) => toast.error(err.message),
                    });
                  }}
                  disabled={deleteUser.isPending}
                  className="text-muted-foreground hover:text-destructive p-1"
                  aria-label={`Delete ${user.email}`}
                >
                  <TrashIcon className="size-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="pt-3 border-t space-y-2">
          <p className="text-sm font-medium">Create user</p>
          <div className="flex flex-col gap-2">
            <Input
              type="email"
              placeholder="email@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-8 text-xs"
            />
            <Input
              type="password"
              placeholder="Password (min 8 chars)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-8 text-xs"
            />
            <Button
              size="sm"
              disabled={!email || password.length < 8 || createUser.isPending}
              onClick={() => {
                createUser.mutate({ email, password }, {
                  onSuccess: () => {
                    setEmail("");
                    setPassword("");
                    toast.success("User created");
                  },
                  onError: (err) => toast.error(err.message),
                });
              }}
              className="w-full"
            >
              <PlusIcon className="size-3.5 mr-1" />
              {createUser.isPending ? "Creating..." : "Create User"}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
