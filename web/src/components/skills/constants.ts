export const PLATFORM_CONFIG: Record<
  string,
  { color: string; label: string }
> = {
  linkedin: {
    color: "bg-blue-600",
    label: "LinkedIn",
  },
  instagram: {
    color: "bg-pink-500",
    label: "Instagram",
  },
  rednote: {
    color: "bg-red-500",
    label: "RedNote",
  },
  x: {
    color: "bg-foreground",
    label: "X",
  },
  "google-maps": {
    color: "bg-green-500",
    label: "Maps",
  },
  meta: {
    color: "bg-purple-500",
    label: "Meta",
  },
};

export const DEFAULT_PLATFORM_CONFIG = {
  color: "bg-muted-foreground",
  label: "Other",
};

export const CAPABILITY_LABELS: Record<string, string> = {
  prospect: "Prospect",
  enrich: "Enrich",
  outreach: "Outreach",
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
  "built-in": "built-in",
  user: "custom",
  github: "github",
  community: "community",
};

export function getPlatformConfig(platform: string | undefined) {
  if (!platform) return DEFAULT_PLATFORM_CONFIG;
  return PLATFORM_CONFIG[platform] ?? DEFAULT_PLATFORM_CONFIG;
}
