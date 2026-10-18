import { redirect } from "next/navigation";

// Research now lives in the terminal: per coin in the focus panel, all coins in the dock.
export default async function Research({ searchParams }: { searchParams: Promise<{ mint?: string }> }) {
  const { mint } = await searchParams;
  redirect(mint && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) ? `/?coin=${mint}&dock=research` : "/?dock=research");
}
