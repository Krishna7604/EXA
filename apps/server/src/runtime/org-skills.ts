// Skills published to the org (or by the user), exposed to server loops as a SkillsPort.
// Read fresh each turn so edits apply immediately.

import type { SkillsPort } from "@exa/core";
import type { ExtensionsRepo } from "../repositories/extensions.repository.ts";

// ---------- org skills ----------
export function orgSkills(
  repo: ExtensionsRepo,
  subject: { tenantId: string; userId: string },
): SkillsPort {
  return {
    list: async () =>
      (await repo.skills(subject)).map((skill) => ({
        name: skill.name,
        description: skill.description,
        location: skillLocation(skill),
      })),
    load: async (name) => {
      const skill = (await repo.skills(subject)).find((x) => x.name === name);
      if (!skill) return null;
      const info = {
        name: skill.name,
        description: skill.description,
        location: skillLocation(skill),
      };
      return { info, body: skill.body };
    },
  };
}

// ---------- helpers ----------
function skillLocation(skill: { scope: string; name: string }): string {
  return `exa://skills/${skill.scope}/${skill.name}`;
}
