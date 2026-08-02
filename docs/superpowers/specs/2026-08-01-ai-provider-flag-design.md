# Flag de provider de IA: Bedrock ou Gemini

**Data:** 2026-08-01
**Status:** Aprovado para planejamento de implementação

## Contexto

O app hoje chama exclusivamente a Amazon Bedrock (Claude Haiku 4.5) em
`src/lib/helion.functions.ts`, via `callBedrock()`. Antes disso, o app chamava
o Gemini diretamente (`gemini-flash-latest`, endpoint compatível com OpenAI);
esse código foi removido no commit `694daf4` ao migrar para o Bedrock, motivado
por um bug real: o "thinking" do Gemini consumia o orçamento de `max_tokens`
e truncava o JSON do Compêndio Avançado em produção (duas vezes, mesmo após
mitigação com `reasoning_effort: "low"` — ver commits `d8e93e1` e `54eb978`).

Motivação para trazer o Gemini de volta como opção: a cota do Bedrock na conta
AWS usada está pendente de liberação (ver README, seção "Status atual"), então
não há como validar uma chamada real de ponta a ponta pela UI até isso
liberar. Um flag de provider permite testar o app hoje mesmo, sem esperar a
AWS, mantendo o Bedrock como o caminho padrão/recomendado.

## Fora de escopo

- Fallback automático (tentar Bedrock, cair pro Gemini em caso de erro). O
  flag é uma escolha explícita, não um mecanismo de alta disponibilidade.
- Qualquer mudança de infraestrutura Terraform (`infra/app` ainda não está
  implementado — quando for, a variável `GEMINI_API_KEY` precisará virar um
  parâmetro SSM `SecureString` igual ao que já está planejado para outros
  segredos, mas isso é trabalho futuro, não parte deste spec).
- Mudança de UI/layout — a escolha de provider é inteiramente server-side via
  variável de ambiente, invisível para quem usa o app.

## Design

### Seleção do provider

```ts
function getProvider(): "bedrock" | "gemini" {
  return process.env.AI_PROVIDER?.trim().toLowerCase() === "gemini" ? "gemini" : "bedrock";
}
```

Qualquer valor ausente, vazio ou desconhecido em `AI_PROVIDER` resolve para
`"bedrock"` — o Bedrock continua sendo o caminho testado em produção; o
Gemini é opt-in explícito.

### `callGemini()`

Reimplementado a partir da versão histórica (`git show 55c88cf`), com as duas
mitigações de truncamento já validadas mantidas:

- `reasoning_effort: "low"` em toda chamada.
- `max_tokens` generoso: 1200 (humanize) / 3200 padrão / 4200 código
  (deepDive) — os mesmos valores já usados pelo Bedrock hoje, que por
  coincidência já são os valores "aumentados" que resolveram o truncamento
  no histórico do Gemini.

Assinatura simétrica ao `callBedrock()` existente, pra manter os dois
igualmente testáveis:

```ts
type GeminiContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export async function callGemini(
  system: string,
  userContent: GeminiContentBlock[],
  maxTokens: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string>;
```

Erros mapeados como no código histórico: HTTP 429 → "Limite de requisições.
Tente novamente em instantes." (mesma mensagem do Bedrock, pra UI não
precisar saber qual provider respondeu), HTTP 402 → "Créditos esgotados na
conta do Gemini.", outros status → `Gemini {status}: {corpo da resposta,
truncado em 200 chars}`.

### Dispatcher `callAI()`

`humanize()` e `deepDive()` não vão mais chamar `callBedrock()` diretamente.
Passam a montar um content neutro e chamar um dispatcher:

```ts
interface AIContent {
  text: string;
  imageDataUrl?: string | null;
}

async function callAI(system: string, content: AIContent, maxTokens: number): Promise<string> {
  if (getProvider() === "gemini") {
    const userContent: GeminiContentBlock[] = [{ type: "text", text: content.text }];
    if (content.imageDataUrl) {
      userContent.push({ type: "image_url", image_url: { url: content.imageDataUrl } });
    }
    return callGemini(system, userContent, maxTokens);
  }
  const userContent: ContentBlock[] = [{ text: content.text }];
  if (content.imageDataUrl) {
    userContent.push({ image: parseDataUrl(content.imageDataUrl) });
  }
  return callBedrock(system, userContent, maxTokens);
}
```

Isso centraliza a decisão de provider e a montagem do content específico de
cada wire format num único lugar, evitando duplicar a lógica de
`isCode`/`userText`/`maxTokens` dentro de `humanize()` e `deepDive()`.
`callBedrock()` e `parseDataUrl()` continuam exatamente como estão hoje —
nenhuma mudança na assinatura ou comportamento deles, então os 4 testes
existentes continuam válidos sem alteração.

O parsing/salvamento de JSON truncado em `deepDive()` já opera sobre o texto
final (`content`), independente de qual provider gerou — nenhuma mudança
necessária ali.

### Variáveis de ambiente

Adicionar a `.env`, `.env.example` e à tabela de env vars do README:

| Variável                 | Uso                                                                |
| ------------------------ | ------------------------------------------------------------------ |
| `AI_PROVIDER` (opcional) | `"bedrock"` (padrão) ou `"gemini"`                                 |
| `GEMINI_API_KEY`         | Obrigatória apenas se `AI_PROVIDER=gemini`; chave da API do Gemini |

### Documentação

A seção "Arquitetura de IA: histórico e decisão atual" do README ganha uma
nota ao final explicando que o Gemini voltou como opção explícita via
`AI_PROVIDER=gemini` (não é mais o default) — útil enquanto a cota do
Bedrock não libera — reforçando que o Bedrock continua sendo o caminho
validado/recomendado por causa do histórico de truncamento.

## Testes

Novo bloco `describe("callGemini", ...)` em
`src/lib/helion.functions.test.ts`, espelhando os 4 testes existentes de
`callBedrock`:

1. Chama o endpoint com `model`, `messages` (system + user), `max_tokens` e
   `reasoning_effort: "low"`; retorna o texto de `choices[0].message.content`.
2. Retorna string vazia quando a resposta não tem `choices[0].message.content`.
3. Lança mensagem amigável em HTTP 429.
4. Lança mensagem com status/corpo em outros erros HTTP.

Os 4 testes existentes de `callBedrock` permanecem inalterados (contrato não
muda).

## Critério de sucesso

- `AI_PROVIDER` ausente ou `=bedrock` → comportamento idêntico ao atual
  (verificado pelos testes existentes continuando a passar sem alteração).
- `AI_PROVIDER=gemini` com `GEMINI_API_KEY` configurada → `humanize()` e
  `deepDive()` funcionam via Gemini, incluindo o caminho de imagem
  (jargões/screenshot e análise de código) e o salvamento de JSON truncado.
- `bun run lint`, `bunx tsc --noEmit` (exceto o erro pré-existente do Nitro,
  não relacionado) e `bun run test` passam.
