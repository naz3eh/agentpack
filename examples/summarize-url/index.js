// summarize-url — example agentpack agent.
// Scopes declared in agentpack.json: net:* + llm:call + env:PAGE_URL + env:SUMMARY_LANG.
// The LLM key lives in the agentpack broker — this process never sees it.

const pageUrl = process.env.PAGE_URL;
const lang = process.env.SUMMARY_LANG ?? "English";
const llmUrl = process.env.AGENTPACK_LLM_URL;

if (!pageUrl) {
  console.error("PAGE_URL env var is required (declared as env:PAGE_URL)");
  process.exit(2);
}
if (!llmUrl) {
  console.error("AGENTPACK_LLM_URL missing — run under `agentpack run` with llm:call declared");
  process.exit(2);
}

const res = await fetch(pageUrl);
if (!res.ok) throw new Error(`fetch ${pageUrl} -> ${res.status}`);
const html = await res.text();
const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 8000);

const llm = await fetch(`${llmUrl}/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: `Summarize the page in one paragraph, in ${lang}.` },
      { role: "user", content: text },
    ],
  }),
});
if (!llm.ok) throw new Error(`llm call failed: ${llm.status} ${await llm.text()}`);
const data = await llm.json();
const summary = data.choices?.[0]?.message?.content ?? "(empty summary)";
console.log(`SUMMARY: ${summary}`);
