import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "SnackOps · 客服智能工作台", description: "Plan + Skill 可配置执行平台" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="zh-CN"><body>{children}</body></html>; }
