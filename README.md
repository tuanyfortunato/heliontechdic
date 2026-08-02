# HELION · Glossário de Tecnologia

HELION é um glossário interativo de tecnologia com IA. O usuário digita um termo, sigla ou expressão técnica (ou envia um print/foto) e a aplicação devolve uma explicação humanizada em português — em tom casual ou técnico, curta ou longa. Há também um modo de **análise de código**, que identifica a linguagem de um trecho de código em uma imagem e explica linha a linha, e um modo **"Compêndio Avançado"** (deep dive), que expande o termo com exemplo prático, analogia, tópicos relacionados e links de referência.

Se o termo/imagem não for sobre tecnologia, a IA responde que está fora do escopo em vez de alucinar uma resposta.

## Stack técnica

| Camada                     | Tecnologia                                                                                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework                  | [TanStack Start](https://tanstack.com/start) (SSR) + [TanStack Router](https://tanstack.com/router)                                                                                                        |
| UI                         | React 19, estilos inline (design tokens em `index.tsx`) + Tailwind CSS 4 só para o reset/base (`src/styles.css`) — não usa shadcn/ui                                                                       |
| Dados/estado               | TanStack Query                                                                                                                                                                                             |
| Build                      | Vite 7 + Nitro (preset `aws-lambda`, streaming habilitado)                                                                                                                                                 |
| IA                         | **Amazon Bedrock** — Claude Haiku 4.5 (`us.anthropic.claude-haiku-4-5-20251001-v1:0`), chamado via `@aws-sdk/client-bedrock-runtime` (`ConverseCommand`), autenticado por credenciais IAM (não há API key) |
| Runtime alvo               | AWS Lambda, invocado via Function URL pública (`RESPONSE_STREAM`) — sem API Gateway, sem ALB, sem VPC                                                                                                      |
| Infraestrutura como código | Terraform (`infra/bootstrap`, `infra/app`)                                                                                                                                                                 |
| Testes                     | Vitest                                                                                                                                                                                                     |
| Gerenciador de pacotes     | [Bun](https://bun.sh)                                                                                                                                                                                      |

## Estrutura do projeto

```
src/
  routes/
    __root.tsx              # shell HTML, <head>, error/404 boundaries
    index.tsx                # tela única da aplicação (formulário + resultado)
  lib/
    helion.functions.ts       # server functions: humanize() e deepDive() (chamam o Bedrock)
    helion.functions.test.ts   # testes da integração com o Bedrock (client mockado)
    error-page.ts               # página HTML de erro genérica
  start.ts                        # configuração do TanStack Start (middlewares globais)
  router.tsx                       # criação do router + query client
infra/
  bootstrap/                        # Terraform: state backend (S3) + roles OIDC do GitHub Actions
                                      # (código escrito, ainda não aplicado — ver "Status atual")
  app/                                # Terraform: Lambda + IAM + Function URL (ainda não implementado)
vite.config.ts                        # Nitro com preset aws-lambda
```

A aplicação é essencialmente uma única rota (`/`) com um formulário complexo — não há páginas adicionais nem autenticação de usuário ativa no momento.

## Variáveis de ambiente

Crie um arquivo `.env` (veja `.env.example`) com:

| Variável                 | Uso                                                                      |
| ------------------------ | ------------------------------------------------------------------------ |
| `AWS_REGION` (opcional)  | Região do Bedrock — padrão `us-east-1` se omitida                        |
| `AI_PROVIDER` (opcional) | `"bedrock"` (padrão) ou `"gemini"` — escolhe qual IA os endpoints chamam |
| `GEMINI_API_KEY`         | Obrigatória apenas se `AI_PROVIDER=gemini`                               |

**Com o provider padrão (Bedrock), não há API key de IA para configurar.** O acesso é via credenciais IAM: rode `aws configure` (ou `aws sso login`) localmente antes de `bun run dev`, para que o SDK da AWS encontre suas credenciais automaticamente. Em produção, a Lambda usa sua própria role de execução (sem credenciais explícitas). Se `AI_PROVIDER=gemini`, defina `GEMINI_API_KEY` — esse caminho usa uma chave de API normal, não credenciais IAM.

As variáveis com prefixo `VITE_` ficam visíveis no bundle do client; as demais só existem no servidor.

## Rodando localmente

```bash
aws configure         # uma vez, se ainda não tiver credenciais AWS configuradas
bun install
bun run dev            # http://localhost:3000
bun run build            # build de produção (gera .output/, preset aws-lambda)
bun run preview            # serve o build de produção localmente
bun run test                # vitest run
bun run lint                  # eslint
bun run format                  # prettier --write
```

---

## Arquitetura de IA: histórico e decisão atual

O projeto passou por três providers de IA até chegar no atual:

1. **AI Gateway do Lovable** (`ai.gateway.lovable.dev`) — removido: só funcionava dentro de um workspace Lovable, inviável fora dele.
2. **Google Gemini, direto** (via endpoint compatível com OpenAI) — tentativa intermediária, com dois problemas reais encontrados em produção:
   - `gemini-2.5-flash` retornava 404 ("no longer available to new users") para a chave do projeto.
   - O modelo seguinte (`gemini-flash-latest`) tem "thinking" (raciocínio interno) habilitado por padrão, que consome o mesmo orçamento de `max_tokens` da resposta visível — isso truncou o JSON do Compêndio Avançado no meio da resposta **duas vezes em produção**, mesmo depois de uma mitigação (`reasoning_effort: "low"`).
3. **Amazon Bedrock, Claude Haiku 4.5** (atual) — escolhido porque:
   - O "extended thinking" do Claude é opt-in (desligado por padrão), então o problema de truncamento do Gemini não se repete.
   - A aplicação já roda na AWS Lambda — a autenticação é feita pela role IAM da própria função, sem precisar guardar nenhuma API key em segredo (SSM Parameter Store, Secrets Manager, etc.).
   - Custo estimado para o volume esperado (~100 requisições/dia): ~US$13/mês — mais caro que as opções mais baratas do Bedrock (Nova Lite/Pro), mas escolhido pela maior confiabilidade de seguimento de instrução/JSON depois do histórico de truncamento.

A implementação vive inteiramente em `src/lib/helion.functions.ts`: `callBedrock()` monta o `ConverseCommand` (system prompt + conteúdo do usuário, incluindo imagens como bytes base64 decodificados de uma data URL) e mapeia erros da AWS (`ThrottlingException`, etc.) para mensagens amigáveis. O parsing do JSON do Compêndio Avançado tem um fallback: se a resposta for cortada no meio (estourou `max_tokens`), o código recupera via regex os campos que já foram totalmente escritos em vez de mostrar o JSON quebrado na tela.

Desde 2026-08-01, o Gemini voltou como opção explícita via `AI_PROVIDER=gemini` (não é mais o default) — útil enquanto a cota do Bedrock não libera na conta AWS nova (ver "Status atual" abaixo). O Bedrock continua sendo o caminho validado/recomendado por causa do histórico de truncamento descrito acima; a implementação do Gemini (`callGemini()`) reaplica as mesmas mitigações (`reasoning_effort: "low"`, `max_tokens` generoso) que resolveram o problema da última vez que esse provider esteve em produção.

## Deploy na AWS

Arquitetura definida no documento de plano (veja abaixo), gerenciada via Terraform em dois módulos raiz:

- **`infra/bootstrap`** — aplicado manualmente, uma vez: bucket S3 de state remoto (com lock nativo do S3, sem DynamoDB), provider OIDC do GitHub e duas IAM roles para o GitHub Actions (deploy de app com permissão restrita, deploy de infra com permissão mais ampla). **Código escrito e validado offline (`terraform validate`), ainda não aplicado** — ver "Status atual" abaixo.
- **`infra/app`** — Lambda, sua role de execução (com permissão `bedrock:InvokeModel`), Function URL pública em modo `RESPONSE_STREAM`, CloudWatch Logs. **Ainda não implementado.**
- **GitHub Actions** (planejado, ainda não implementado): um workflow que builda e faz deploy do código a cada push em `main`, outro que roda `terraform plan`/`apply` quando arquivos de infra mudam — ambos autenticando via OIDC, sem chaves AWS estáticas no repositório.

Documentação completa, tarefa por tarefa: [`docs/superpowers/plans/2026-08-01-remove-lovable-aws-lambda.md`](docs/superpowers/plans/2026-08-01-remove-lovable-aws-lambda.md).

## Status atual / pendências

- ✅ App roda localmente sem nenhuma dependência do Lovable.
- ✅ IA migrada para Amazon Bedrock (Claude Haiku 4.5), código commitado e testado (mocks).
- ⏳ **Cota do Bedrock pendente**: a conta AWS usada é nova, e a AWS aplica um limite quase zero de tokens/dia por padrão para contas novas (proteção anti-fraude). Pedido de aumento de cota já aberto (`CASE_OPENED`), resposta típica em 12-24h. Até isso liberar, não há como validar uma chamada real de ponta a ponta pela UI.
- ⏳ `infra/bootstrap` escrito mas não aplicado — falta `terraform apply` com credenciais AWS reais (é um passo manual, nunca rodado por CI).
- ⏳ `infra/app` (Lambda, Function URL) e os workflows de CI/CD (GitHub Actions) ainda não foram implementados.
