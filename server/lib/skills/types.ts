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

export type SkillSummary = SkillFrontmatter;

export interface LoadedSkill extends SkillSummary {
  instructions: string;
  files: string[];
}
