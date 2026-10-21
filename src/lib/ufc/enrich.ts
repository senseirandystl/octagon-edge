import { createServerFn } from "@tanstack/react-start";

type Provider = "grok" | "openai" | "anthropic";

type EnrichInput = {
  provider: Provider;
  apiKey?: string;
  event: string;
  date: string;
  location: string;
  a: string;
  b: string;
  weight: string;
  context: string;
};

const SYSTEM = `You are a cautious MMA analyst. Summarize only qualitative, pre-fight factors that could move this bout: recent surgery or injury, camp changes, long layoffs already public, movies or outside projects, contract or personal distractions, and unusual travel. Do not invent reports. If you are not confident something is current, say it is unverified or unknown. 5 short bullets max. No betting advice.`;

export const scoutFight = createServerFn({ method: "POST" })
  .validator((input: EnrichInput) => {
    const provider = input?.provider;
    if (provider !== "grok" && provider !== "openai" && provider !== "anthropic") {
      throw new Error("Choose Grok, ChatGPT, or Anthropic.");
    }
    if (!input.a || !input.b || !input.event) throw new Error("Missing fight.");
    return {
      provider,
      apiKey: typeof input.apiKey === "string" ? input.apiKey.trim() : "",
      event: String(input.event).slice(0, 160),
      date: String(input.date).slice(0, 40),
      location: String(input.location).slice(0, 160),
      a: String(input.a).slice(0, 80),
      b: String(input.b).slice(0, 80),
      weight: String(input.weight).slice(0, 80),
      context: String(input.context ?? "").slice(0, 1800),
    };
  })
  .handler(async ({ data }) => {
    const user = `${data.event} on ${data.date} in ${data.location}. ${data.weight}: ${data.a} vs ${data.b}.\nStructured notes already computed:\n${data.context}\nAdd only outside-the-numbers context.`;

    if (data.provider === "grok") {
      const apiKey = process.env.XAI_API_KEY;
      if (!apiKey) return { ok: false as const, error: "Grok is not available in this environment." };
      const res = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "grok-4.5",
          max_tokens: 420,
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: user },
          ],
        }),
      });
      if (!res.ok) return { ok: false as const, error: `Grok request failed (${res.status}).` };
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return { ok: true as const, text: body.choices?.[0]?.message?.content?.trim() || "No notes returned." };
    }

    if (!data.apiKey) {
      return { ok: false as const, error: "Paste an API key for this provider. It is used once and not saved." };
    }

    if (data.provider === "openai") {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${data.apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          max_tokens: 420,
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: user },
          ],
        }),
      });
      if (!res.ok) return { ok: false as const, error: `ChatGPT request failed (${res.status}).` };
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return { ok: true as const, text: body.choices?.[0]?.message?.content?.trim() || "No notes returned." };
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": data.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 420,
        system: SYSTEM,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) return { ok: false as const, error: `Anthropic request failed (${res.status}).` };
    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = body.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n").trim();
    return { ok: true as const, text: text || "No notes returned." };
  });
