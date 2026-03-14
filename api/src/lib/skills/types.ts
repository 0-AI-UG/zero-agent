export interface SkillMetadata {
  version: string;
  requires: {
    env: string[];
    bins: string[];
  };
  capabilities: string[];
  platform: string;
  login_required: boolean;
  tags: string[];
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  metadata: SkillMetadata;
}

export type SkillSource = "built-in" | "user" | "github" | "community";

export interface SkillSummary extends SkillFrontmatter {
  s3Key: string;
  source: SkillSource;
  published: boolean;
  downloads: number;
}

export interface LoadedSkill extends SkillSummary {
  instructions: string;
  files: string[];
}
