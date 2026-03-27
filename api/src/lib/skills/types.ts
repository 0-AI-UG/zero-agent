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

export interface SkillSummary extends SkillFrontmatter {
  s3Key: string;
}

export interface LoadedSkill extends SkillSummary {
  instructions: string;
  files: string[];
}
