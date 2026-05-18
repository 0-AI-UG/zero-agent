import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router";
import { useCurrentUser } from "@/api/admin";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FingerprintIcon, Trash2Icon, MoonIcon, SunIcon, MonitorIcon, PaletteIcon, UploadIcon, XIcon, ChevronLeftIcon, PencilIcon } from "lucide-react";
import { passkeyRegisterOptions, passkeyRegisterVerify, passkeyList, passkeyDelete } from "@/api/passkeys";
import { startRegistration } from "@simplewebauthn/browser";
import { NotificationsCenter } from "@/components/settings/NotificationsCenter";
import { useColorModeStore, resolveColorMode, type ColorMode } from "@/stores/color-mode";
import { validateThemeConfig, EXAMPLE_THEMES, type ThemeConfig, type ThemeColors } from "@/lib/theme-engine";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";

const NAV_ITEMS = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "security", label: "Security" },
  { id: "notifications", label: "Notifications" },
] as const;

export function AccountPage() {
  const { data: user } = useCurrentUser();
  const navigate = useNavigate();
  const [activeSection, setActiveSection] = useState<string>("general");
  const contentRef = useRef<HTMLDivElement>(null);

  const handleNav = useCallback((id: string) => {
    const el = document.getElementById(`section-${id}`);
    if (el && contentRef.current) {
      const top = el.getBoundingClientRect().top - contentRef.current.getBoundingClientRect().top + contentRef.current.scrollTop - 24;
      contentRef.current.scrollTo({ top, behavior: "smooth" });
    }
  }, []);

  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;

    const handleScroll = () => {
      const containerRect = container.getBoundingClientRect();
      let current: string = NAV_ITEMS[0].id;

      for (const { id } of NAV_ITEMS) {
        const el = document.getElementById(`section-${id}`);
        if (el) {
          const top = el.getBoundingClientRect().top - containerRect.top;
          if (top <= 80) {
            current = id;
          }
        }
      }
      setActiveSection(current);
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  if (!user) return null;

  return (
    <div className="flex h-full">
      {/* Second-level sidebar */}
      <nav className="hidden md:flex flex-col w-56 shrink-0 pt-10 pb-6 pl-8 pr-4">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1.5 mb-6 text-xl font-bold tracking-tight font-display hover:opacity-70 transition-opacity"
        >
          <ChevronLeftIcon className="size-5" />
          Settings
        </button>
        <div className="space-y-0.5">
          {NAV_ITEMS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => handleNav(id)}
              className={`w-full text-left px-3 py-2 rounded-md text-[15px] transition-colors ${
                activeSection === id
                  ? "bg-accent text-accent-foreground font-semibold"
                  : "text-muted-foreground font-medium hover:text-foreground hover:bg-accent/50"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </nav>

      {/* Content */}
      <div ref={contentRef} className="flex-1 overflow-y-auto">
        <div className="max-w-3xl px-4 md:px-10 pt-6 md:pt-10 pb-8 space-y-10">

          {/* General */}
          <div id="section-general">
            <h3 className="text-sm font-semibold mb-4">General</h3>
            <div className="rounded-lg border p-4">
              <p className="text-sm text-muted-foreground">{user.username}</p>
            </div>
          </div>

          {/* Appearance */}
          <div id="section-appearance">
            <AppearanceSection />
          </div>

          {/* Security */}
          <div id="section-security">
            <h3 className="text-sm font-semibold mb-4">Security</h3>
            <p className="text-sm text-muted-foreground mb-6">
              Passkeys are required to sign in when two-factor authentication is enabled on your account.
            </p>
            <PasskeySection />
          </div>

          {/* Notifications */}
          <div id="section-notifications">
            <NotificationsCenter />
          </div>
        </div>
      </div>
    </div>
  );
}

const COLOR_MODE_OPTIONS: { value: ColorMode; label: string; icon: typeof MoonIcon }[] = [
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "system", label: "System", icon: MonitorIcon },
];

const COLOR_FIELDS: { key: keyof ThemeColors; label: string }[] = [
  { key: "background", label: "Background" },
  { key: "foreground", label: "Text" },
  { key: "accent", label: "Accent" },
  { key: "muted", label: "Muted" },
  { key: "border", label: "Border" },
];

function AppearanceSection() {
  const colorMode = useColorModeStore((s) => s.colorMode);
  const setColorMode = useColorModeStore((s) => s.setColorMode);
  const customTheme = useColorModeStore((s) => s.customTheme);
  const setCustomTheme = useColorModeStore((s) => s.setCustomTheme);
  const setCustomThemeCss = useColorModeStore((s) => s.setCustomThemeCss);
  const customThemeName = useColorModeStore((s) => s.customThemeName);
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<ThemeConfig | null>(null);
  const isDark = resolveColorMode(colorMode) === "dark";

  const handleJsonUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    setError("");
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 50_000) { setError("File too large (max 50KB)"); return; }

    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;

      if (file.name.endsWith(".css")) {
        if (text.includes("<script")) { setError("Invalid CSS file"); return; }
        if (!text.includes("--")) { setError("CSS must contain variable overrides"); return; }
        setCustomThemeCss(text, file.name);
        return;
      }

      try {
        const parsed = JSON.parse(text);
        const result = validateThemeConfig(parsed);
        if (!result.ok) { setError(result.error); return; }
        setCustomTheme(result.config);
      } catch {
        setError("Invalid JSON file");
      }
    };
    reader.readAsText(file);
    if (fileRef.current) fileRef.current.value = "";
  };

  const applyPreset = (preset: ThemeConfig) => {
    setCustomTheme(preset);
    setError("");
  };

  const startEditing = () => {
    if (customTheme) {
      setEditing(structuredClone(customTheme));
    } else {
      setEditing(structuredClone(EXAMPLE_THEMES[0]!));
    }
  };

  const saveEditing = () => {
    if (!editing) return;
    const result = validateThemeConfig(editing);
    if (!result.ok) { setError(result.error); return; }
    setCustomTheme(result.config);
    setEditing(null);
    setError("");
  };

  const updateEditColor = (mode: "light" | "dark", key: keyof ThemeColors, value: string) => {
    if (!editing) return;
    setEditing({
      ...editing,
      colors: {
        ...editing.colors,
        [mode]: { ...editing.colors[mode], [key]: value },
      },
    });
  };

  const activeName = customTheme?.name ?? customThemeName;
  const activeColors = customTheme ? (isDark ? customTheme.colors.dark : customTheme.colors.light) : null;

  return (
    <section className="space-y-4">
      <h3 className="text-sm font-semibold">Appearance</h3>

      <div className="rounded-lg border p-4 space-y-5">
        {/* Color mode */}
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Color mode</p>
          <div className="flex gap-2">
            {COLOR_MODE_OPTIONS.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                onClick={() => setColorMode(value)}
                className={`flex items-center gap-2 px-3 py-2 rounded-md border text-sm transition-colors ${
                  colorMode === value
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border bg-transparent text-muted-foreground hover:border-primary/40"
                }`}
              >
                <Icon className="size-4" />
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Custom theme */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">Theme</p>
            {activeName && (
              <button
                onClick={() => { setCustomTheme(null); setCustomThemeCss(null, null); }}
                className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                Reset to default
              </button>
            )}
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}

          {/* Theme grid — always visible */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {EXAMPLE_THEMES.map((t) => {
              const isSelected = customTheme?.name === t.name;
              const colors = isDark ? t.colors.dark : t.colors.light;
              return (
                <button
                  key={t.name}
                  onClick={() => isSelected ? setCustomTheme(null) : applyPreset(t)}
                  className={`group flex flex-col rounded-lg overflow-hidden transition-all ${
                    isSelected
                      ? "ring-2 ring-primary ring-offset-2 ring-offset-background"
                      : "ring-1 ring-border hover:ring-primary/30"
                  }`}
                >
                  {/* Color swatch strip */}
                  <div className="flex h-16">
                    {([colors.background, colors.foreground, colors.accent, colors.muted, colors.border] as const).map((c, i) => (
                      <div key={i} className="flex-1" style={{ background: c }} />
                    ))}
                  </div>
                  <div className="flex items-center justify-between px-3 py-2.5 bg-card">
                    <span className={`text-xs font-medium transition-colors ${
                      isSelected ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"
                    }`}>
                      {t.name}
                    </span>
                    {isSelected && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setEditing(structuredClone(t)); }}
                        className="text-muted-foreground hover:text-foreground transition-colors"
                        aria-label="Edit theme"
                      >
                        <PencilIcon className="size-3" />
                      </button>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Actions */}
          <div className="flex gap-2 items-center">
            <Button variant="outline" size="sm" onClick={startEditing}>
              <PaletteIcon className="size-3.5 mr-1.5" />
              Create Theme
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,.css"
              onChange={handleJsonUpload}
              className="hidden"
            />
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              <UploadIcon className="size-3.5 mr-1.5" />
              Upload
            </Button>
            <p className="text-[10px] text-muted-foreground">.json or .css</p>
          </div>
        </div>
      </div>

      {/* Theme editor dialog */}
      <Dialog open={!!editing} onOpenChange={(open) => { if (!open) { setEditing(null); setError(""); } }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Theme</DialogTitle>
          </DialogHeader>

          {editing && (
            <div className="space-y-5">
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Theme name</label>
                <Input
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder="My Theme"
                />
              </div>

              {(["light", "dark"] as const).map((mode) => (
                <div key={mode} className="space-y-3">
                  <p className="text-sm font-medium capitalize">{mode} mode</p>
                  <div className="grid grid-cols-5 gap-3">
                    {COLOR_FIELDS.map(({ key, label }) => (
                      <div key={key} className="space-y-1.5">
                        <label className="text-xs text-muted-foreground">{label}</label>
                        <div className="relative">
                          <input
                            type="color"
                            value={editing.colors[mode][key]}
                            onChange={(e) => updateEditColor(mode, key, e.target.value)}
                            className="absolute inset-0 opacity-0 cursor-pointer"
                          />
                          <div
                            className="h-10 rounded-lg border border-border cursor-pointer transition-shadow hover:ring-2 hover:ring-ring"
                            style={{ background: editing.colors[mode][key] }}
                          />
                        </div>
                        <input
                          type="text"
                          value={editing.colors[mode][key]}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (/^#[0-9a-fA-F]{0,6}$/.test(v)) updateEditColor(mode, key, v);
                          }}
                          className="w-full text-[11px] font-mono bg-transparent text-muted-foreground border-0 p-0 focus:outline-none"
                          spellCheck={false}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              {/* Preview strip */}
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">Preview</p>
                <div className="flex rounded-lg overflow-hidden h-8">
                  {(isDark
                    ? [editing.colors.dark.background, editing.colors.dark.foreground, editing.colors.dark.accent, editing.colors.dark.muted, editing.colors.dark.border]
                    : [editing.colors.light.background, editing.colors.light.foreground, editing.colors.light.accent, editing.colors.light.muted, editing.colors.light.border]
                  ).map((c, i) => (
                    <div key={i} className="flex-1" style={{ background: c }} />
                  ))}
                </div>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => { setEditing(null); setError(""); }}>Cancel</Button>
            <Button onClick={saveEditing}>Apply Theme</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function PasskeySection() {
  const [passkeys, setPasskeys] = useState<{ id: string; deviceName: string; createdAt: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [deviceName, setDeviceName] = useState("");
  const [showNameInput, setShowNameInput] = useState(false);

  const fetchPasskeys = async () => {
    try {
      const data = await passkeyList();
      setPasskeys(data.passkeys);
    } catch {
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchPasskeys(); }, []);

  const handleAdd = async () => {
    setError("");
    setAdding(true);
    try {
      const { ceremonyId, ...options } = await passkeyRegisterOptions();
      const registration = await startRegistration({ optionsJSON: options as any });
      await passkeyRegisterVerify(ceremonyId, registration, deviceName || "Passkey");
      setDeviceName("");
      setShowNameInput(false);
      await fetchPasskeys();
    } catch (err) {
      if (err instanceof Error && err.name === "NotAllowedError") {
        setError("Passkey registration was cancelled");
      } else {
        setError(err instanceof Error ? err.message : "Failed to add passkey");
      }
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (id: string) => {
    setError("");
    try {
      await passkeyDelete(id);
      setPasskeys((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete passkey");
    }
  };

  if (loading) return null;

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <FingerprintIcon className="size-4 text-muted-foreground" />
        <h4 className="text-sm font-medium">Two-factor authentication</h4>
      </div>

      <div className="rounded-lg border p-4 space-y-4">
        {error && <p className="text-xs text-destructive">{error}</p>}

        {passkeys.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Use biometrics (Face ID, Touch ID) or a hardware security key to verify your identity when signing in.
          </p>
        ) : (
          <div className="space-y-2">
            {passkeys.map((p) => (
              <div key={p.id} className="flex items-center justify-between py-2 px-3 rounded-md bg-muted/50">
                <div className="flex items-center gap-2.5">
                  <FingerprintIcon className="size-4 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">{p.deviceName}</p>
                    <p className="text-xs text-muted-foreground">
                      Added {new Date(p.createdAt + "Z").toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => handleDelete(p.id)}
                  aria-label="Delete passkey"
                >
                  <Trash2Icon className="size-3.5 text-muted-foreground" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {showNameInput ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Passkey name</label>
              <Input
                type="text"
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                placeholder="e.g. MacBook Touch ID"
                autoFocus
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={handleAdd} disabled={adding} size="sm">
                {adding ? "Registering..." : "Register Passkey"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setShowNameInput(false); setDeviceName(""); setError(""); }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button onClick={() => setShowNameInput(true)} size="sm">
            Add Passkey
          </Button>
        )}
      </div>
    </section>
  );
}
