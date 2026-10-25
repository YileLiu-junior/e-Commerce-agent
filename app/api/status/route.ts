import { NextResponse } from "next/server";
import { getAiStatus } from "@/lib/engine";
import { gateMode, gateRuntimeStatus, gateThresholds, priceCheckEnabled } from "@/lib/decision";
import { getPlanner, getSkills, getTools } from "@/lib/store";
export async function GET() {
  const [skills, tools, planner] = await Promise.all([getSkills(), getTools(), getPlanner()]);
  return NextResponse.json({
    ai: getAiStatus(),
    planner: { name: planner.name, enabled: planner.enabled },
    skills: skills.filter(s => s.enabled),
    tools: tools.filter(t => t.enabled),
    gate: {
      mode: gateMode(),
      configured: Boolean(process.env.STARTLUX_API_KEY || process.env.BAMBOO_API_KEY),
      priceCheck: priceCheckEnabled(),
      thresholds: gateThresholds(),
      runtime: gateRuntimeStatus()
    }
  });
}
