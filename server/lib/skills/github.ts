import { log } from "@/lib/logger.ts";

const ghLog = log.child({ module: "skills:github" });

interface GitHubParsedUrl {
  owner: string;
  repo: string;
  branch: string;
  path: string;
}

interface DiscoveredSkill {
  name: string;
  description: string;
  metadata: Record<string, unknown>;
  path: string;
}

interface GitHubTreeItem {
  path: string;
  type: "blob" | "tree";
  url: string;
}

export function parseGitHubUrl(url: string): GitHubParsedUrl {
  const match = url.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.*))?)?$/,
  );
  if (!match) {
    throw new Error("Invalid GitHub URL. Expected: https://github.com/owner/repo or https://github.com/owner/repo/tree/branch/path");
  }

  return {
    owner: match[1]!,
    repo: match[2]!,
    branch: match[3] ?? "main",
    path: match[4] ?? "",
  };
}

export async function discoverSkills(
  owner: string,
  repo: string,
  branch: string,
  basePath: string,
): Promise<DiscoveredSkill[]> {
  // Fetch the repo tree recursively
  const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
  ghLog.info("fetching tree", { treeUrl });

  const res = await fetch(treeUrl, {
    headers: {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "skills-installer",
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as { tree: GitHubTreeItem[] };

  // Find all SKILL.md files under basePath
  const prefix = basePath ? `${basePath}/` : "";
  const skillMdPaths = data.tree
    .filter((item) => item.type === "blob" && item.path.startsWith(prefix) && item.path.endsWith("/SKILL.md"))
    .map((item) => item.path);

  const skills: DiscoveredSkill[] = [];

  for (const skillMdPath of skillMdPaths) {
    try {
      const content = await fetchRawFile(owner, repo, branch, skillMdPath);
      const { parseSkillMd } = await import("./parser.ts");
      const { frontmatter } = parseSkillMd(content);

      // Extract skill directory name
      const parts = skillMdPath.split("/");
      const skillDir = parts[parts.length - 2]!;

      skills.push({
        name: frontmatter.name,
        description: frontmatter.description,
        metadata: frontmatter.metadata as unknown as Record<string, unknown>,
        path: skillMdPath.replace("/SKILL.md", ""),
      });
    } catch (err) {
      ghLog.error("failed to parse skill", err, { path: skillMdPath });
    }
  }

  return skills;
}

async function fetchRawFile(
  owner: string,
  repo: string,
  branch: string,
  path: string,
): Promise<string> {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status}`);
  }
  return res.text();
}

export async function fetchSkillFiles(
  owner: string,
  repo: string,
  branch: string,
  skillPath: string,
): Promise<{ path: string; content: string }[]> {
  // Get the tree for the skill directory
  const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
  const res = await fetch(treeUrl, {
    headers: {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "skills-installer",
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as { tree: GitHubTreeItem[] };
  const prefix = `${skillPath}/`;
  const blobs = data.tree.filter(
    (item) => item.type === "blob" && item.path.startsWith(prefix),
  );

  const files: { path: string; content: string }[] = [];
  for (const blob of blobs) {
    const content = await fetchRawFile(owner, repo, branch, blob.path);
    const relativePath = blob.path.slice(prefix.length);
    files.push({ path: relativePath, content });
  }

  return files;
}
