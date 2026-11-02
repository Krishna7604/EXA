// Agent-loop ports that combine local sources with ones published on the server
// (skills, instructions).

import type { SkillsPort } from "@exa/core";
import type { PublishedSkill } from "../models/api.model.ts";

// ---------- types ----------
/** A skill published to the org (or user) on the server. */
export type OrgSkill = PublishedSkill;

interface InstructionSource {
  load(): Promise<Array<{ source: string; content: string }>>;
}

// ---------- ports ----------
/** Concatenate instructions from every non-null source, in order. */
export function combineInstructions(...ports: Array<InstructionSource | null>): InstructionSource {
  return {
    load: async () => (await Promise.all(ports.filter((p) => p).map((p) => p!.load()))).flat(),
  };
}

/** Local SKILL.md files first, then skills published to the org on the server. */
export function mergeSkills(local: SkillsPort, org: OrgSkill[]): SkillsPort {
  return {
    async list() {
      const l = await local.list();
      const names = new Set(l.map((x) => x.name));
      return [...l, ...org.filter((x) => !names.has(x.name)).map(orgSkillInfo)];
    },
    async load(name) {
      const l = await local.load(name);
      if (l) return l;
      const o = org.find((x) => x.name === name);
      return o ? { info: orgSkillInfo(o), body: o.body } : null;
    },
  };
}

// ---------- helpers ----------
function orgSkillInfo(x: OrgSkill) {
  return {
    name: x.name,
    description: x.description,
    location: `exa://skills/${x.scope}/${x.name}`,
  };
}
