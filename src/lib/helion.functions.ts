import { createServerFn } from "@tanstack/react-start";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

// Cross-region inference profile ID -- Claude Haiku 4.5 rejects direct
// on-demand invocation by its bare model ID ("Invocation of model ID ...
// with on-demand throughput isn't supported"); it must be invoked through
// an inference profile. Verified against the real Bedrock endpoint.
const MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const REGION = process.env.AWS_REGION || "us-east-1";

// No API key: auth is via the caller's/Lambda's IAM credentials (SigV4),
// picked up automatically from the environment (~/.aws credentials locally,
// the execution role in Lambda).
const bedrockClient = new BedrockRuntimeClient({ region: REGION });

type Mode = "casual" | "tecnica";
type Length = "curta" | "longa";
type Analise = "padrao" | "codigo";

interface HumanizeInput {
  termo: string;
  modo: Mode;
  tamanho: Length;
  imageDataUrl?: string | null;
  analise?: Analise;
}

function toneText(modo: Mode) {
  return modo === "casual"
    ? "linguagem casual e acessível, como um amigo apaixonado por tech explicando"
    : "linguagem técnica e precisa, própria para profissionais de TI";
}

function sizeText(tamanho: Length) {
  return tamanho === "curta"
    ? "concisa, até 3 parágrafos, direto ao ponto"
    : "aprofundada, com 4 a 6 parágrafos, analogias e exemplos";
}

function systemPrompt(modo: Mode, tamanho: Length, analise: Analise) {
  if (analise === "codigo") {
    return `Você é um mentor sênior de programação. A entrada é uma imagem contendo código-fonte. Sua tarefa:

1. Identifique a LINGUAGEM de programação na imagem (ex.: Python, JavaScript, Go, SQL, Bash…). Comece a resposta exatamente assim:
**Linguagem detectada:** <nome da linguagem>

2. Explique o PROPÓSITO geral do trecho (1 parágrafo).

3. Faça uma análise LINHA A LINHA. Para cada linha relevante, mostre o trecho em \`código\` e explique de forma aprofundada o que ela faz, incluindo o significado de comandos, operadores, símbolos (\`=>\`, \`::\`, \`->\`, \`&&\`, \`*\`, \`&\`, etc.), palavras-chave e estruturas de controle.

4. Encerre com **Boas práticas / observações** (1 parágrafo) sobre o que poderia ser melhorado ou pontos de atenção.

REGRAS:
- Português brasileiro, tom: ${toneText(modo)}.
- Extensão: ${sizeText(tamanho)}, mas NUNCA pule a análise linha a linha.
- Se a imagem NÃO contiver código de programação, responda APENAS com: {"fora_de_escopo":true}
- Texto puro com **negrito** para destaque; sem markdown com #; pode usar \`crase\` para trechos curtos de código.`;
  }
  return `Você é um especialista apaixonado em tecnologia. Responde APENAS sobre tecnologia, computação, programação, hardware, software, internet, redes, segurança, IA e afins.

REGRA ABSOLUTA: se o termo/imagem NÃO for de tecnologia, responda SOMENTE com o JSON exato: {"fora_de_escopo":true}

Se for sobre tecnologia:
- Português brasileiro
- Tom: ${toneText(modo)}
- Extensão: ${sizeText(tamanho)}
- Estilo OBRIGATÓRIO: fala fluida, humanizada, didática — como uma conversa inteligente entre amigos. Sem listas com bullet points. Prosa contínua e envolvente.
- Não repita o nome do termo como título no início.
- Expanda siglas naturalmente dentro da explicação.
- Responda em texto puro (sem JSON, sem markdown com #). Pode usar **negrito** para destaque.`;
}

type ImageFormat = "png" | "jpeg" | "webp" | "gif";
type ContentBlock =
  | { text: string }
  | { image: { format: ImageFormat; source: { bytes: Uint8Array } } };

function parseDataUrl(dataUrl: string): { format: ImageFormat; source: { bytes: Uint8Array } } {
  const match = dataUrl.match(/^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/);
  if (!match) throw new Error("Formato de imagem não suportado.");
  const format = (match[1] === "jpg" ? "jpeg" : match[1]) as ImageFormat;
  return { format, source: { bytes: new Uint8Array(Buffer.from(match[2], "base64")) } };
}

export async function callBedrock(
  system: string,
  userContent: ContentBlock[],
  maxTokens: number,
  client: Pick<BedrockRuntimeClient, "send"> = bedrockClient,
): Promise<string> {
  try {
    const res = await client.send(
      new ConverseCommand({
        modelId: MODEL_ID,
        system: [{ text: system }],
        messages: [{ role: "user", content: userContent }],
        inferenceConfig: { maxTokens },
      }),
    );
    const block = res.output?.message?.content?.[0];
    return block && "text" in block ? (block.text ?? "") : "";
  } catch (err: unknown) {
    const name = err instanceof Error ? err.name : undefined;
    if (name === "ThrottlingException")
      throw new Error("Limite de requisições. Tente novamente em instantes.");
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Bedrock ${name ?? "error"}: ${message.slice(0, 200)}`);
  }
}

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
    if (res.status === 429) throw new Error("Limite de requisições. Tente novamente em instantes.");
    if (res.status === 402) throw new Error("Créditos esgotados na conta do Gemini.");
    throw new Error(`Gemini ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

export const humanize = createServerFn({ method: "POST" })
  .inputValidator((d: HumanizeInput) => d)
  .handler(async ({ data }) => {
    const isCode = data.analise === "codigo" && !!data.imageDataUrl;
    const userText = isCode
      ? `Analise o código presente nesta imagem conforme as instruções do sistema (linguagem, propósito, linha a linha, boas práticas).${data.termo ? ` Contexto do usuário: "${data.termo}".` : ""}`
      : data.imageDataUrl
        ? `Identifique e explique os jargões, siglas ou expressões técnicas presentes nesta imagem.${data.termo ? ` Contexto adicional do usuário: "${data.termo}".` : ""}`
        : `Explique o seguinte termo/sigla/expressão de tecnologia: "${data.termo}"`;
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

    const trimmed = content.trim();
    if (trimmed.includes('"fora_de_escopo"') && trimmed.includes("true")) {
      return { foraDeEscopo: true as const };
    }
    return { foraDeEscopo: false as const, texto: trimmed };
  });

interface DeepDiveInput {
  termo: string;
  analise?: Analise;
  contextoCodigo?: string | null;
}

const DEEP_SYSTEM_PADRAO = `Você é um especialista em tecnologia. Para o termo informado, responda EXCLUSIVAMENTE com um JSON válido (sem markdown, sem texto extra) com este formato exato:
{
  "profundidade": "3-5 parágrafos detalhados sobre o tema",
  "exemplo": "exemplo real em 1-2 parágrafos",
  "analogia": "analogia criativa em 1-2 frases",
  "relacionados": ["conceito1","conceito2","conceito3","conceito4"],
  "docLink": "URL da documentação oficial ou null"
}
Em português brasileiro. Prosa fluida, sem listas com bullets dentro do texto. Se não houver documentação oficial clara, use null no docLink (sem aspas).`;

const DEEP_SYSTEM_CODIGO = `Você é um mentor sênior de programação. Receberá a LINGUAGEM detectada (e opcionalmente o uso/propósito do trecho analisado). Responda EXCLUSIVAMENTE com JSON válido (sem markdown, sem texto extra) neste formato exato:
{
  "profundidade": "3-5 parágrafos detalhados sobre a linguagem detectada e sobre o uso específico do código analisado, conectando os dois",
  "exemplo": "exemplo de código real comentado em 1-2 parágrafos, ilustrando o mesmo uso",
  "analogia": "analogia criativa em 1-2 frases",
  "relacionados": ["conceito1","conceito2","conceito3","conceito4"],
  "docLink": "URL da documentação oficial da linguagem ou null",
  "videos": [{"titulo":"...","url":"https://www.youtube.com/results?search_query=..."}],
  "artigos": [{"titulo":"...","url":"https://..."}],
  "exemplosLinks": [{"titulo":"...","url":"https://..."}]
}
Em português brasileiro. Em videos/artigos/exemplosLinks, inclua 3 itens cada, COBRINDO TANTO a linguagem detectada QUANTO o uso específico do trecho. Prefira fontes confiáveis (documentação oficial, MDN, DevDocs, freeCodeCamp, GitHub, Real Python, etc.). Use URLs reais sempre que possível; quando não tiver certeza, use buscas no formato "https://www.google.com/search?q=..." ou "https://www.youtube.com/results?search_query=...".`;

export const deepDive = createServerFn({ method: "POST" })
  .inputValidator((d: DeepDiveInput) => d)
  .handler(async ({ data }) => {
    const isCode = data.analise === "codigo";
    const userText = isCode
      ? `Linguagem/termo: ${data.termo}.${data.contextoCodigo ? ` Contexto do código analisado: ${data.contextoCodigo}` : ""}`
      : `Termo: ${data.termo}`;
    const content = await callBedrock(
      isCode ? DEEP_SYSTEM_CODIGO : DEEP_SYSTEM_PADRAO,
      [{ text: userText }],
      isCode ? 4200 : 3200,
    );
    let jsonText = content.trim();
    const fence = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) jsonText = fence[1].trim();
    const firstBrace = jsonText.indexOf("{");
    const lastBrace = jsonText.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      jsonText = jsonText.slice(firstBrace, lastBrace + 1);
    }
    try {
      const parsed = JSON.parse(jsonText);
      const parseLinks = (arr: unknown) =>
        Array.isArray(arr)
          ? arr
              .slice(0, 5)
              .map((it: unknown) => {
                const obj = it as { titulo?: unknown; url?: unknown } | null | undefined;
                return { titulo: String(obj?.titulo ?? ""), url: String(obj?.url ?? "") };
              })
              .filter((it) => it.titulo && it.url)
          : [];
      return {
        profundidade: String(parsed.profundidade ?? ""),
        exemplo: String(parsed.exemplo ?? ""),
        analogia: String(parsed.analogia ?? ""),
        relacionados: Array.isArray(parsed.relacionados)
          ? parsed.relacionados.slice(0, 8).map((s: unknown) => String(s))
          : [],
        docLink: parsed.docLink && parsed.docLink !== "null" ? String(parsed.docLink) : null,
        videos: parseLinks(parsed.videos),
        artigos: parseLinks(parsed.artigos),
        exemplosLinks: parseLinks(parsed.exemplosLinks),
      };
    } catch {
      // The Bedrock response got cut off mid-JSON (hit max_tokens before
      // closing the object). Rather than show the broken JSON verbatim,
      // salvage whichever string fields the model DID finish writing --
      // each closed field is still valid within an otherwise-truncated
      // object, since fields are emitted in schema order.
      const field = (key: string): string => {
        const m = jsonText.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "s"));
        if (!m) return "";
        try {
          return JSON.parse(`"${m[1]}"`);
        } catch {
          return m[1];
        }
      };
      const profundidade = field("profundidade");
      return {
        // Last resort only: if not even `profundidade` could be salvaged,
        // fall back to the raw text so nothing is silently lost.
        profundidade: profundidade || content,
        exemplo: field("exemplo"),
        analogia: field("analogia"),
        relacionados: [] as string[],
        docLink: null as string | null,
        videos: [] as { titulo: string; url: string }[],
        artigos: [] as { titulo: string; url: string }[],
        exemplosLinks: [] as { titulo: string; url: string }[],
      };
    }
  });
