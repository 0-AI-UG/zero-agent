export const PLATFORM_CONFIG: Record<
  string,
  { color: string; label: string }
> = {};

export const DEFAULT_PLATFORM_CONFIG = {
  color: "bg-muted-foreground",
  label: "Other",
};

export const CAPABILITY_LABELS: Record<string, string> = {
  prospect: "Prospect",
  enrich: "Enrich",
  scrape: "Scrape",
  engage: "Engage",
  analyze: "Analyze",
  monitor: "Monitor",
  export: "Export",
  search: "Search",
  message: "Message",
  connect: "Connect",
  login: "Login",
  create: "Create",
  research: "Research",
};

export const SOURCE_LABELS: Record<string, string> = {
  user: "custom",
  github: "github",
};

export function getPlatformConfig(platform: string | undefined) {
  if (!platform) return DEFAULT_PLATFORM_CONFIG;
  return PLATFORM_CONFIG[platform] ?? DEFAULT_PLATFORM_CONFIG;
}
