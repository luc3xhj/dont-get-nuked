"use client";

// One poller per worker endpoint, shared by every terminal panel.
import { createContext, useContext } from "react";
import type { ActivityItem, AgentState, PortfolioReport } from "@/lib/agent";
import { usePolling, useSolPrice } from "@/lib/hooks";

type TerminalData = {
  state: AgentState | null;
  portfolio: PortfolioReport | null;
  activity: ActivityItem[] | null;
  solUsd: number;
  error: string | null;
};

const Ctx = createContext<TerminalData | null>(null);

export function TerminalDataProvider({ children }: { children: React.ReactNode }) {
  const state = usePolling<AgentState>("/api/agent/state", 2_500);
  const portfolio = usePolling<PortfolioReport>("/api/agent/portfolio", 3_000);
  const activity = usePolling<ActivityItem[]>("/api/agent/activity?limit=120", 2_000);
  const solUsd = useSolPrice();
  return (
    <Ctx.Provider
      value={{
        state: state.data,
        portfolio: portfolio.data,
        activity: activity.data,
        solUsd,
        error: (!state.data && state.error) || (!portfolio.data && portfolio.error) || null,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useTerminal() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTerminal must be used inside TerminalDataProvider");
  return ctx;
}
