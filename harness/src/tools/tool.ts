// Tool base — class-based foundation for all harness tools.
// Phase 1 adds Zod `tool()` defs; this base keeps name/description/readonly
// flags (Claude Code pattern) plus a typed execute contract.

export abstract class BaseTool<
  Args extends Record<string, unknown> = Record<string, unknown>,
  Result = unknown,
> {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly readonly: boolean;
  abstract execute(args: Args): Promise<Result>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, BaseTool<Record<string, unknown>, unknown>>();

  constructor(tools: BaseTool<Record<string, unknown>, unknown>[] = []) {
    for (const t of tools) this.register(t);
  }

  register(tool: BaseTool<Record<string, unknown>, unknown>): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): BaseTool<Record<string, unknown>, unknown> | undefined {
    return this.tools.get(name);
  }

  require(name: string): BaseTool<Record<string, unknown>, unknown> {
    const t = this.tools.get(name);
    if (!t) throw new Error(`unknown tool: ${name}`);
    return t;
  }

  list(): BaseTool<Record<string, unknown>, unknown>[] {
    return [...this.tools.values()];
  }

  async run(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.require(name).execute(args);
  }
}
