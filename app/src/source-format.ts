export interface PromptCitation {
  ref: string;
  date: string;
  snippet: string;
  quoted?: {
    text?: string;
    handle?: string;
    date?: string;
  } | null;
}

export function sourceTweetForPrompt(c: PromptCitation): string {
  let out = `[${c.ref}] (${c.date}) KOL tweet: ${c.snippet}`;
  if (c.quoted?.text) {
    const qWho = c.quoted.handle ? `@${c.quoted.handle}` : "quoted account";
    const qDate = c.quoted.date ? ` ${c.quoted.date}` : "";
    out += `\n    Quoted context (${qWho}${qDate}): ${c.quoted.text}`;
  }
  return out;
}
