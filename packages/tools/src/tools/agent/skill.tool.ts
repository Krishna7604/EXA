// skill: load a skill's full SKILL.md body on demand (the system prompt only lists names).

import { defineTool, type SkillsPort } from "@exa/core";
import { z } from "zod";

// ---------- skill tool ----------
export const skillTool = defineTool({
  name: "skill",
  description:
    "Load a skill's full instructions by name (see <available_skills> in the system prompt). Call it before starting a task that matches a skill's description.",
  schema: z.object({ name: z.string().min(1).describe("Skill name") }),
  readonly: true,
  permissions: (input) => [{ permission: "skill", patterns: [input.name] }],
  async execute(input, ctx) {
    const skills = ctx.services.skills as SkillsPort | undefined;
    const s = await skills?.load(input.name);
    if (!s) throw new Error(await notFoundMessage(input.name, skills));
    const baseDir = s.info.location.replace(/\/SKILL\.md$/, "");
    const body = `<skill name="${s.info.name}" location="${s.info.location}">\n${s.body.trim()}\n</skill>`;
    return {
      output: `${body}\n\nRelative paths in this skill are relative to ${baseDir}.`,
      title: s.info.name,
      metadata: { location: s.info.location },
    };
  },
});

// ---------- helpers ----------
async function notFoundMessage(name: string, skills: SkillsPort | undefined): Promise<string> {
  const all = (await skills?.list()) ?? [];
  const names = all.map((x) => x.name).join(", ") || "none";
  return `Skill "${name}" not found. Available: ${names}`;
}
