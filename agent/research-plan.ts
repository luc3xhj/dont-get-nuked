import type { ResearchQuery, ResearchSource } from "../src/lib/research-types";

export type ResearchInput = {
  mint: string; name: string; symbol: string;
  socials: { twitter: string | null; website: string | null; telegram: string | null };
  social?: { url: string | null; text: string | null; author: string | null; error: string | null } | null;
};
const clean = (s: string, max = 100) => s.replace(/https?:\/\/\S+/gi, " ").replace(/["<>\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const NARRATIVE_FILLER = new Set("a an the this that these those is are was were be been being it its i ive im you your we our they their he hes she shes in on at to of for from with and or but as by so if than like might most thing ever seen literally really just now going up fast views likes million mill viral token coin buy pump solana".split(" "));

export function narrativeTerms(text: string): string {
  const words = clean(text, 500).replace(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, "")
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/)
    .filter((word) => word.length > 2 && !NARRATIVE_FILLER.has(word.toLowerCase().replace(/'/g, "")));
  return [...new Set(words)].slice(0, 24).join(" ");
}

/** Only public HTTP links; never expose URL credentials or arbitrary query-string values. */
export function publicUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || !u.hostname.includes(".") || /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname)) return null;
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (/^(token|access_token|api_key|key|auth|secret|signature)$/i.test(key)) return null;
      if (/^(utm_|fbclid|gclid)/i.test(key)) u.searchParams.delete(key);
    }
    return u.href;
  } catch { return null; }
}

/** A bounded, deterministic search plan. Search terms are data, never model instructions. */
export function researchPlan(c: ResearchInput): ResearchQuery[] {
  const name = clean(c.name);
  const symbol = clean(c.symbol, 30);
  const plan: ResearchQuery[] = [
    { kind: "contract", query: `"${c.mint}"`, purpose: "Find evidence mentioning this exact Solana contract address" },
    { kind: "identity", query: `"${name || symbol}" ${symbol !== name ? symbol : ""} Solana token`.trim(), purpose: "Find this coin by name; distinguish namesakes, competing contracts and original projects" },
  ];
  const social = publicUrl(c.socials.twitter) ?? publicUrl(c.socials.telegram);
  if (social) {
    const u = new URL(social);
    const handle = u.pathname.split("/").filter(Boolean)[0];
    const isX = /(^|\.)(x|twitter)\.com$/.test(u.hostname);
    const domains = isX ? ["x.com", "twitter.com"] : [u.hostname];
    const accountPath = isX && handle && !["i", "intent", "search"].includes(handle) ? `x.com/${handle}` : `${u.hostname}${u.pathname.replace(/\/$/, "")}`;
    plan.push({ kind: "social", query: `site:${accountPath} "${name || symbol}"`, domains, purpose: "Find information from the linked social account or community and its connection to this coin; a metadata link is not an endorsement" });
  }
  const website = publicUrl(c.socials.website) ?? (social ? publicUrl(c.socials.telegram) : null);
  if (website && website !== social) {
    const u = new URL(website);
    plan.push({ kind: "website", query: `site:${u.hostname}${u.pathname === "/" ? "" : u.pathname} "${name || symbol}"`, purpose: "Find indexed information on the linked website or community; do not assume ownership or contract association" });
  }
  const narrative = narrativeTerms(c.social?.text ?? "");
  plan.push({ kind: "narrative", query: narrative.length >= 15 ? narrative : `"${name || symbol}" meme origin community`, purpose: "Check the underlying narrative and original context; narrative popularity does not verify this contract" });
  return plan.filter((p, i) => plan.findIndex((x) => x.query === p.query) === i).slice(0, 5);
}

export function mergeSources(sources: ResearchSource[]): ResearchSource[] {
  const merged = new Map<string, ResearchSource>();
  for (const s of sources) {
    const url = publicUrl(s.url);
    if (!url) continue;
    const old = merged.get(url);
    if (old) {
      old.queryKinds = [...new Set([...old.queryKinds, ...s.queryKinds])];
      // Keep the text that supports the label, including when the match is in the title.
      if ((s.mentionsContract && !old.mentionsContract) || (s.via === "linked_social" && !old.mentionsContract)) {
        old.title = s.title; old.snippet = s.snippet; old.via = s.via;
      }
      old.mentionsContract ||= s.mentionsContract;
    } else merged.set(url, { ...s, url, queryKinds: [...s.queryKinds] });
  }
  return [...merged.values()].slice(0, 24);
}
