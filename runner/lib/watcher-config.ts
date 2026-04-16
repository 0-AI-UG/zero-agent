export const WATCHER_CONFIG = {
  excludes: [".git", "node_modules", ".venv", "venv", "dist", "build", ".next", "target", "__pycache__", ".cache", ".pytest_cache"],
  maxFileBytes: 25 * 1024 * 1024,
  debounceMs: 500,
};
