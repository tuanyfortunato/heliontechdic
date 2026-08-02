# AI Provider Flag (Bedrock/Gemini) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `humanize()`/`deepDive()` call either Amazon Bedrock (current, default) or Google Gemini (brought back as an explicit opt-in) based on an `AI_PROVIDER` environment variable, so the app can be exercised end-to-end while the Bedrock quota request is pending.

**Architecture:** A new `callGemini()` mirrors the existing `callBedrock()` (same error-mapping shape, injectable transport for tests). A new `getProvider()`/`callAI()` pair centralizes the env-var branch and the per-provider content-block adaptation, so `humanize()`/`deepDive()` call one provider-agnostic function instead of duplicating branch logic twice each.

**Tech Stack:** TypeScript, Vitest (`vi.stubEnv`), `@aws-sdk/client-bedrock-runtime` (unchanged), `fetch` (Gemini's OpenAI-compatible endpoint).

## Global Constraints

- `AI_PROVIDER` unset or any value other than the literal string `"gemini"` (case-insensitive) → Bedrock. Bedrock stays the default; Gemini is opt-in only.
- No automatic fallback between providers — this is an explicit switch, not high availability.
- `callBedrock()` and `parseDataUrl()` keep their exact current signatures and behavior — the 4 existing tests in `src/lib/helion.functions.test.ts` must keep passing unmodified.
- Gemini model: `gemini-flash-latest`. Endpoint: `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`. Every Gemini call sets `reasoning_effort: "low"` (truncation mitigation, see spec).
- `maxTokens` values stay exactly what they are today for both providers: `humanize` 1200, `deepDive` 3200 (padrão) / 4200 (código).
- `GEMINI_API_KEY` is only required at runtime when `AI_PROVIDER=gemini`; missing key throws before any network call.
- Design reference: `docs/superpowers/specs/2026-08-01-ai-provider-flag-design.md`.

---

### Task 1: `callGemini()`

**Files:**

- Modify: `src/lib/helion.functions.ts` (insert after line 109, the closing `}` of `callBedrock`, before line 111 `export const humanize`)
- Modify: `src/lib/helion.functions.test.ts:1` (import line) and end of file (new `describe` block)

**Interfaces:**

- Produces: `export async function callGemini(system: string, userContent: GeminiContentBlock[], maxTokens: number, fetchImpl?: typeof fetch): Promise<string>` and `export type GeminiContentBlock = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }` — both consumed by Task 2.

- [ ] **Step 1: Write the failing tests**

In `src/lib/helion.functions.test.ts`, change the import line from:

```ts
import { describe, it, expect, vi } from "vitest";
import { callBedrock } from "./helion.functions";
```

to:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callBedrock, callGemini } from "./helion.functions";
```

Then append this block at the end of the file:

```ts

describe("callGemini", () => {
  beforeEach(() => {
    vi.stubEnv("GEMINI_API_KEY", "test-gemini-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("calls the Gemini endpoint with model/messages/max_tokens/reasoning_effort and returns the text content", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "hello world" } }] }),
      text: async () => "",
    });

    const result = await callGemini(
      "system prompt",
      [{ type: "text", text: "hi" }],
      100,
      fetchMock as unknown as typeof fetch,
    );

    expect(result).toBe("hello world");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer test-gemini-key");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: "gemini-flash-latest",
      max_tokens: 100,
      reasoning_effort: "low",
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
    });
  });

  it("returns an empty string when the response has no choices", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [] }),
      text: async () => "",
    });

    const result = await callGemini(
      "s",
      [{ type: "text", text: "hi" }],
      100,
      fetchMock as unknown as typeof fetch,
    );
    expect(result).toBe("");
  });

  it("throws a friendly message on HTTP 429", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({}),
      text: async () => "Too many requests",
    });

    await expect(
      callGemini("s", [{ type: "text", text: "hi" }], 100, fetchMock as unknown as typeof fetch),
    ).rejects.toThrow("Limite de requisições");
  });

  it("wraps other HTTP errors with the status and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => "internal error",
    });

    await expect(
      callGemini("s", [{ type: "text", text: "hi" }], 100, fetchMock as unknown as typeof fetch),
    ).rejects.toThrow("Gemini 500: internal error");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test`
Expected: FAIL — `callGemini` is not exported from `./helion.functions` (module has no export named 'callGemini').

- [ ] **Step 3: Implement `callGemini`**

In `src/lib/helion.functions.ts`, insert this block after line 109 (right after the closing `}` of `callBedrock`, before `export const humanize`):

```ts
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
// gemini-2.5-flash returns 404 ("no longer available to new users") for
// newly-created API keys/projects; gemini-flash-latest is the current
// flash-tier alias and works with this key (verified against the real
// Gemini endpoint in the app's Gemini-only era, commit 55c88cf).
const GEMINI_MODEL = "gemini-flash-latest";

export type GeminiContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export async function callGemini(
  system: string,
  userContent: GeminiContentBlock[],
  maxTokens: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");
  const res = await fetchImpl(GEMINI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GEMINI_MODEL,
      max_tokens: maxTokens,
      // gemini-flash-latest's thinking (reasoning) tokens count against
      // max_tokens and can consume the whole budget before any visible
      // content is emitted, truncating the response mid-sentence
      // (finish_reason: "length") -- "low" leaves enough headroom.
      // Verified against the real Gemini endpoint (commits d8e93e1, 54eb978).
      reasoning_effort: "low",
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429)
      throw new Error("Limite de requisições. Tente novamente em instantes.");
    if (res.status === 402) throw new Error("Créditos esgotados na conta do Gemini.");
    throw new Error(`Gemini ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test`
Expected: PASS — all tests in `callBedrock` (4) and `callGemini` (4) green.

- [ ] **Step 5: Lint and typecheck**

Run: `bun run lint && bunx tsc --noEmit`
Expected: 0 lint problems. `tsc` shows only the pre-existing, unrelated `vite.config.ts` Nitro error (confirm it's the same single error as before this task).

- [ ] **Step 6: Commit**

```bash
git add src/lib/helion.functions.ts src/lib/helion.functions.test.ts
git commit -m "feat: add callGemini() as an alternate AI transport"
```

---

### Task 2: `getProvider()` + `callAI()` dispatcher, wire into `humanize`/`deepDive`

**Files:**

- Modify: `src/lib/helion.functions.ts:111-140` (`humanize`) and `:171-182` (`deepDive`, line numbers as of Task 1's insertion — re-locate by content, not by number, since Task 1 shifted lines down)
- Modify: `src/lib/helion.functions.test.ts` (new `describe` blocks)

**Interfaces:**

- Consumes: `callBedrock` (Task 0/existing), `callGemini`/`GeminiContentBlock` (Task 1), `ContentBlock`/`parseDataUrl` (existing, module-private).
- Produces: `export function getProvider(): "bedrock" | "gemini"` and `export async function callAI(system: string, content: { text: string; imageDataUrl?: string | null }, maxTokens: number, deps?: { bedrockClient?: Pick<BedrockRuntimeClient, "send">; fetchImpl?: typeof fetch }): Promise<string>` — both used directly by `humanize()`/`deepDive()` in this same task, no later task depends on them.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/helion.functions.test.ts` (after the `callGemini` describe block added in Task 1):

```ts

describe("getProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to bedrock when AI_PROVIDER is unset", () => {
    expect(getProvider()).toBe("bedrock");
  });

  it("returns gemini when AI_PROVIDER=gemini (case-insensitive)", () => {
    vi.stubEnv("AI_PROVIDER", "Gemini");
    expect(getProvider()).toBe("gemini");
  });

  it("falls back to bedrock for unrecognized values", () => {
    vi.stubEnv("AI_PROVIDER", "openai");
    expect(getProvider()).toBe("bedrock");
  });
});

describe("callAI", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("routes to Bedrock by default", async () => {
    const sendMock = vi.fn().mockResolvedValue({
      output: { message: { content: [{ text: "bedrock reply" }] } },
    });
    const fetchMock = vi.fn();

    const result = await callAI("system", { text: "hi" }, 100, {
      bedrockClient: { send: sendMock },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toBe("bedrock reply");
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes to Gemini when AI_PROVIDER=gemini", async () => {
    vi.stubEnv("AI_PROVIDER", "gemini");
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const sendMock = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "gemini reply" } }] }),
      text: async () => "",
    });

    const result = await callAI("system", { text: "hi" }, 100, {
      bedrockClient: { send: sendMock },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toBe("gemini reply");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("includes the image in the Bedrock content when imageDataUrl is set", async () => {
    const sendMock = vi.fn().mockResolvedValue({
      output: { message: { content: [{ text: "ok" }] } },
    });

    await callAI("system", { text: "hi", imageDataUrl: "data:image/png;base64,AAAA" }, 100, {
      bedrockClient: { send: sendMock },
    });

    const command = sendMock.mock.calls[0][0];
    expect(command.input.messages[0].content).toEqual([
      { text: "hi" },
      { image: { format: "png", source: { bytes: expect.any(Uint8Array) } } },
    ]);
  });

  it("includes the image in the Gemini content when imageDataUrl is set", async () => {
    vi.stubEnv("AI_PROVIDER", "gemini");
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
      text: async () => "",
    });

    await callAI("system", { text: "hi", imageDataUrl: "data:image/png;base64,AAAA" }, 100, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.messages[1].content).toEqual([
      { type: "text", text: "hi" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  });
});
```

Update the import line again to include the two new names:

```ts
import { callBedrock, callGemini, getProvider, callAI } from "./helion.functions";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test`
Expected: FAIL — `getProvider`/`callAI` not exported from `./helion.functions`.

- [ ] **Step 3: Implement `getProvider()` and `callAI()`**

Insert this block right after the `callGemini` function added in Task 1 (i.e., after its closing `}`, before `export const humanize`):

```ts
export function getProvider(): "bedrock" | "gemini" {
  return process.env.AI_PROVIDER?.trim().toLowerCase() === "gemini" ? "gemini" : "bedrock";
}

interface AIContent {
  text: string;
  imageDataUrl?: string | null;
}

interface CallAIDeps {
  bedrockClient?: Pick<BedrockRuntimeClient, "send">;
  fetchImpl?: typeof fetch;
}

export async function callAI(
  system: string,
  content: AIContent,
  maxTokens: number,
  deps: CallAIDeps = {},
): Promise<string> {
  if (getProvider() === "gemini") {
    const userContent: GeminiContentBlock[] = [{ type: "text", text: content.text }];
    if (content.imageDataUrl) {
      userContent.push({ type: "image_url", image_url: { url: content.imageDataUrl } });
    }
    return callGemini(system, userContent, maxTokens, deps.fetchImpl);
  }
  const userContent: ContentBlock[] = [{ text: content.text }];
  if (content.imageDataUrl) {
    userContent.push({ image: parseDataUrl(content.imageDataUrl) });
  }
  return callBedrock(system, userContent, maxTokens, deps.bedrockClient);
}
```

Then, inside `humanize()`'s handler, replace:

```ts
    const userContent: ContentBlock[] = [{ text: userText }];
    if (data.imageDataUrl) {
      userContent.push({ image: parseDataUrl(data.imageDataUrl) });
    }

    // Claude's extended thinking is opt-in (unlike Gemini's default-on
    // thinking, which repeatedly ate the max_tokens budget and truncated
    // responses) -- it's left disabled here, so the whole budget goes to
    // visible output.
    const content = await callBedrock(
      systemPrompt(data.modo, data.tamanho, data.analise ?? "padrao"),
      userContent,
      1200,
    );
```

with:

```ts
    const content = await callAI(
      systemPrompt(data.modo, data.tamanho, data.analise ?? "padrao"),
      { text: userText, imageDataUrl: data.imageDataUrl },
      1200,
    );
```

And inside `deepDive()`'s handler, replace:

```ts
    const content = await callBedrock(
      isCode ? DEEP_SYSTEM_CODIGO : DEEP_SYSTEM_PADRAO,
      [{ text: userText }],
      isCode ? 4200 : 3200,
    );
```

with:

```ts
    const content = await callAI(
      isCode ? DEEP_SYSTEM_CODIGO : DEEP_SYSTEM_PADRAO,
      { text: userText },
      isCode ? 4200 : 3200,
    );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test`
Expected: PASS — all `callBedrock` (4), `callGemini` (4), `getProvider` (3), `callAI` (4) tests green (15 total).

- [ ] **Step 5: Lint and typecheck**

Run: `bun run lint && bunx tsc --noEmit`
Expected: 0 lint problems (in particular, no unused-import warnings for `ContentBlock`/`parseDataUrl` — they're still used inside `callAI`). `tsc` shows only the same pre-existing Nitro error as before.

- [ ] **Step 6: Manual smoke check (dev server)**

Run: `bun run dev`, open `http://localhost:3000`, submit a term with default env (no `AI_PROVIDER` set). Confirm the request still reaches Bedrock exactly as before this change (same behavior as production today — this only re-confirms the default path wasn't altered; it does NOT require AWS credentials to succeed if you don't have them locally, but the app should fail the same way it did before this task, not with a new/different error).

- [ ] **Step 7: Commit**

```bash
git add src/lib/helion.functions.ts src/lib/helion.functions.test.ts
git commit -m "feat: dispatch humanize/deepDive to Bedrock or Gemini via AI_PROVIDER"
```

---

### Task 3: Env vars, README, final verification

**Files:**

- Modify: `.env.example`
- Modify: `.env` (local only — gitignored, not part of the commit)
- Modify: `README.md`

**Interfaces:**

- Consumes: nothing new (documents `AI_PROVIDER`/`GEMINI_API_KEY` already implemented in Task 1/2).
- Produces: nothing consumed by later tasks — this is the final task.

- [ ] **Step 1: Update `.env.example`**

Current end of file:

```
# AWS_REGION=us-east-1
```

Replace with:

```
# AWS_REGION=us-east-1

# Optional: switch the AI provider. "bedrock" (default) or "gemini".
# AI_PROVIDER=bedrock

# Only required when AI_PROVIDER=gemini.
GEMINI_API_KEY=
```

- [ ] **Step 2: Update local `.env` (not committed)**

Append the same two lines (commented `AI_PROVIDER`, empty `GEMINI_API_KEY`) to `.env` for local-dev convenience. This file is gitignored — do not `git add` it.

- [ ] **Step 3: Update `README.md` env vars table**

Find:

```
| Variável                | Uso                                               |
| ----------------------- | -------------------------------------------------- |
| `AWS_REGION` (opcional) | Região do Bedrock — padrão `us-east-1` se omitida |
```

Replace with:

```
| Variável                    | Uso                                                                       |
| --------------------------- | -------------------------------------------------------------------------- |
| `AWS_REGION` (opcional)     | Região do Bedrock — padrão `us-east-1` se omitida                        |
| `AI_PROVIDER` (opcional)    | `"bedrock"` (padrão) ou `"gemini"` — escolhe qual IA os endpoints chamam  |
| `GEMINI_API_KEY`            | Obrigatória apenas se `AI_PROVIDER=gemini`                                |
```

(Match the existing table's exact column widths/alignment style found in the file — the content above is illustrative; run `bun run format` afterward to let Prettier fix table alignment automatically.)

- [ ] **Step 4: Add a note to the "Arquitetura de IA" section of `README.md`**

Immediately after the paragraph ending in "...para não mostrar o JSON quebrado na tela." (the paragraph describing `callBedrock()`'s salvage fallback), add a new paragraph:

```markdown
Desde 2026-08-01, o Gemini voltou como opção explícita via `AI_PROVIDER=gemini` (não é mais o default) — útil enquanto a cota do Bedrock não libera na conta AWS nova (ver "Status atual" abaixo). O Bedrock continua sendo o caminho validado/recomendado por causa do histórico de truncamento descrito acima; a implementação do Gemini (`callGemini()`) reaplica as mesmas mitigações (`reasoning_effort: "low"`, `max_tokens` generoso) que resolveram o problema da última vez que esse provider esteve em produção.
```

- [ ] **Step 5: Run full verification**

Run: `bun run lint && bunx tsc --noEmit; bun run test && bun run build`
Expected: `lint` 0 problems, `tsc` only the pre-existing Nitro error, `test` all passing (15 tests), `build` succeeds.

- [ ] **Step 6: Commit**

```bash
git add .env.example README.md
git commit -m "docs: document AI_PROVIDER/GEMINI_API_KEY env vars"
```
