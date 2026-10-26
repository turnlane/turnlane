import { Navigate } from "@tanstack/react-router";
import { useConn } from "./App.tsx";
import { AppShell } from "./layout/AppShell.tsx";
import { useOnboardingState } from "./onboarding/data.ts";

export function Shell() {
  const conn = useConn();
  // 流れが済んでいなければオンボーディングへ（onboarding.md 3章。途中で閉じても同じ段から）
  const ob = useOnboardingState();
  if (ob.data && ob.data.state !== "done") return <Navigate to="/onboarding" />;
  return <AppShell conn={conn} />;
}
