import { describe, it, expect } from "vitest";
import { parseAgentsMd, parseBmadAgent } from "@/lib/devsphere-agent-api";

/**
 * A BMAD Core agent file, trimmed from a real one
 * (.devaccel/agents/mainframe-discovery.md). The shape that matters: an HTML
 * comment, an H1, prose, and then a fenced yaml block — and NO frontmatter.
 */
const BMAD_CORE = `<!-- Powered by BMAD™ Core -->

# mainframe-discovery

ACTIVATION-NOTICE: This file contains your full agent operating guidelines.

\`\`\`yaml
activation-instructions:
  - STEP 1: Read THIS ENTIRE FILE
agent:
  name: Grace
  id: mainframe-discovery
  title: Mainframe Discovery Analyst
  icon: 🗄️
  whenToUse: Use for brownfield discovery on legacy z/OS estates.
  customization: null
persona:
  role: Legacy Systems Archaeologist
commands:
  - help: Show numbered list of commands
\`\`\`
`;

describe("parseBmadAgent", () => {
  /*
   * Regression: this file resolved to nothing on both ends, so selecting the
   * agent produced "Custom agent 'mainframe-discovery' not found — expected a
   * definition under .devaccel/agents/ or .claude/agents/" even though the
   * file sat exactly there and had been uploaded with the request.
   */
  it("parses an agent that frontmatter parsing cannot see", () => {
    expect(parseAgentsMd(BMAD_CORE)).toEqual([]);

    const agent = parseBmadAgent(BMAD_CORE, "mainframe-discovery");
    expect(agent).not.toBeNull();
    // `id` is the slug the server matches agent_name against; BMAD's `name:`
    // is the human being.
    expect(agent!.name).toBe("mainframe-discovery");
    expect(agent!.persona).toBe("Grace");
    expect(agent!.title).toBe("Mainframe Discovery Analyst");
    expect(agent!.description).toContain("brownfield discovery");
    expect(agent!.icon).toBe("🗄️");
  });

  it("keeps the whole file as the prompt — BMAD agents are self-contained", () => {
    const agent = parseBmadAgent(BMAD_CORE, "x")!;
    expect(agent.system_prompt).toContain("ACTIVATION-NOTICE");
    expect(agent.system_prompt).toContain("commands:");
  });

  it("falls back to the filename when the block declares no id", () => {
    const noId = BMAD_CORE.replace("  id: mainframe-discovery\n", "");
    expect(parseBmadAgent(noId, "from-filename")!.name).toBe("from-filename");
    expect(parseBmadAgent(noId, "")).toBeNull();
  });

  it("ignores markdown with no agent mapping", () => {
    expect(parseBmadAgent("# Notes\n\n```yaml\nfoo: bar\n```\n", "n")).toBeNull();
    expect(parseBmadAgent("# Just a document\n\nNo yaml here.\n", "n")).toBeNull();
  });

  it("does not hijack a normal frontmatter agent", () => {
    const fm = `---\nname: mary\ndescription: Business analyst\n---\n\nYou are Mary.\n`;
    expect(parseAgentsMd(fm).map((a) => a.name)).toEqual(["mary"]);
    expect(parseBmadAgent(fm, "mary")).toBeNull();
  });
});
