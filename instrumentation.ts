// Next.js 服务启动钩子：生产环境禁止 mock 闸门（静默安全旁路，spec §3.6）。
export async function register() {
  const mode = String(process.env.STARTLUX_GATE_MODE || "off").trim().toLowerCase();
  if (process.env.NODE_ENV === "production" && mode === "mock") {
    throw new Error("STARTLUX_GATE_MODE=mock 在生产环境被禁止：mock 是固定概率的安全旁路。请改用 live/live_shadow/off。");
  }
}
