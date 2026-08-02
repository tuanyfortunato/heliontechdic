# Remover dependência do Lovable e migrar para AWS Lambda

**Data:** 2026-08-01
**Status:** Aprovado para planejamento de implementação

## Contexto

O projeto HELION (glossário de tecnologia com IA, TanStack Start + React 19 +
Supabase) foi criado no Lovable e hoje tem três pontos de acoplamento que
impedem rodar fora daquele ambiente:

1. `vite.config.ts` usa o pacote privado `@lovable.dev/vite-tanstack-config`,
   que embrulha toda a configuração do Vite/TanStack e não resolve fora do
   workspace do Lovable.
2. O deploy alvo atual é Cloudflare Workers (`wrangler.jsonc` +
   `src/server.ts` como module worker + `@cloudflare/vite-plugin`).
3. A funcionalidade central do produto (as duas _server functions_ de IA em
   `src/lib/helion.functions.ts`) chama o AI Gateway do Lovable
   (`ai.gateway.lovable.dev`), autenticado com `LOVABLE_API_KEY` — uma chave
   que só existe dentro de um workspace Lovable.

O objetivo deste documento é registrar as decisões tomadas para (a) tornar o
projeto executável localmente sem qualquer dependência do Lovable e (b)
publicá-lo na AWS pelo menor custo possível, dado que o app tem tráfego muito
baixo (uso pessoal/poucas requisições).

## Fora de escopo

- Domínio próprio / certificado customizado (usa-se o endpoint HTTPS padrão
  gerado pela AWS).
- Autenticação de usuário (a integração Supabase já escafoldada em
  `src/integrations/supabase/` não é consumida pela UI hoje e continua fora
  de escopo).
- Observabilidade avançada (alarmes, dashboards) além dos logs padrão do
  CloudWatch que o Lambda já gera automaticamente.
- Manter Cloudflare Workers como alvo de deploy secundário — é removido por
  completo.

## Parte 1 — Remover o Lovable, rodar local

### `vite.config.ts`

Substituir o `defineConfig` do pacote do Lovable pela configuração explícita
equivalente, sem o `componentTagger` (ferramenta de edição visual exclusiva
do editor Lovable) nem a detecção de sandbox (porta/host, também exclusiva
de lá):

```ts
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tailwindcss(),
    tanstackStart(),
    nitro({ preset: "aws-lambda", awsLambda: { streaming: true } }),
    viteReact(),
  ],
});
```

### `src/server.ts` e `src/start.ts`

- `src/server.ts` é removido: era o _module worker_ do Cloudflare
  (`fetch(request, env, ctx)`); o preset `aws-lambda` do Nitro gera seu
  próprio handler compatível com Lambda, então essa camada deixa de existir
  como está.
- A lógica de página de erro amigável (`renderErrorPage` para respostas 500
  "engolidas" pelo h3) permanece coberta pelo `errorMiddleware` já existente
  em `src/start.ts` — nenhum comportamento de tratamento de erro se perde.

### `src/lib/helion.functions.ts`

Trocar a chamada ao AI Gateway do Lovable por uma chamada direta à API do
Gemini, mantendo o mesmo modelo (`google/gemini-2.5-flash`) e toda a lógica
de prompts/parsing como está:

- Remove: `GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions"`
  e `process.env.LOVABLE_API_KEY`.
- Adiciona: chamada ao endpoint do Gemini compatível com o formato OpenAI
  Chat Completions, autenticada com uma nova env var `GEMINI_API_KEY`.
- `callGateway()` muda pouco além da URL/autenticação, já que o formato de
  request/response permanece compatível.

### Remoções

- Pasta `.lovable/` (metadados do template do editor).
- Dependência `@lovable.dev/vite-tanstack-config` (`package.json`).
- Dependência `@cloudflare/vite-plugin` (`package.json`).
- `wrangler.jsonc`.
- Linha `minimumReleaseAgeExcludes = ["@lovable.dev/vite-tanstack-config"]`
  em `bunfig.toml`.

### Ajustes cosméticos

- `twitter:site: "@Lovable"` em `src/routes/__root.tsx` (linha 82) — trocar
  por um valor genérico do projeto ou remover a tag.
- Mensagens "Connect Supabase in Lovable Cloud" em `client.ts`,
  `client.server.ts` e `auth-middleware.ts` (`src/integrations/supabase/`)
  — trocar por instruções genéricas de configurar as variáveis de ambiente
  do Supabase.

### Novo: `.env.example`

Documentar as variáveis necessárias: `GEMINI_API_KEY`, `VITE_SUPABASE_URL`
/ `SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` /
`SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_PROJECT_ID`,
`SUPABASE_SERVICE_ROLE_KEY`.

### Critério de sucesso desta parte

`bun install && bun run dev` funciona localmente sem nenhuma variável ou
pacote do Lovable, e o app responde nas mesmas rotas/funcionalidades de
hoje.

## Parte 2 — Infraestrutura AWS (Lambda)

Dado que o app tem tráfego muito baixo, a arquitetura de menor custo é AWS
Lambda com Function URL — duas outras opções (ECS Fargate + ALB, EC2
`t4g.micro` sem ALB) foram avaliadas e descartadas por custo (ver
"Alternativas consideradas" abaixo).

- **Compute**: preset `aws-lambda` do Nitro (`awsLambda: { streaming: true }`),
  gerando um handler compatível com Lambda a partir do mesmo código
  TanStack Start — sem reescrever a aplicação.
- **Invocação**: **Lambda Function URL**, não API Gateway. Mais simples, sem
  custo por requisição adicional, e já serve em **HTTPS por padrão** com
  certificado gerenciado pela AWS (sem precisar de domínio próprio ou ACM).
  Configurada com `auth_type = "NONE"` (acesso público, sem IAM auth — é um
  site, não uma API interna) e `invoke_mode = "RESPONSE_STREAM"` (exigido
  para casar com `awsLambda: { streaming: true }` do preset Nitro; o modo
  padrão `BUFFERED` quebraria o streaming da resposta SSR).
- **Empacotamento**: **zip**, não Docker/ECR — não há necessidade de
  container para uma função Lambda desse porte, e isso simplifica o pipeline
  de deploy (sem build/push de imagem).
- **Rede**: **sem VPC**. Supabase e a API do Gemini são endpoints públicos
  HTTPS, então o Lambda roda fora de qualquer VPC, evitando a penalidade de
  cold start com ENI e qualquer custo de NAT Gateway.
- **IAM**:
  - _Role de execução do Lambda_ (usada em runtime): apenas as permissões
    básicas de execução (`AWSLambdaBasicExecutionRole`, escrita em
    CloudWatch Logs). **Não** precisa de permissão de leitura no SSM, porque
    os segredos são injetados como variáveis de ambiente no momento do
    `terraform apply` (ver abaixo) — o código da aplicação nunca faz uma
    chamada à AWS em runtime para buscar segredo.
  - _Identidade que roda o Terraform_ (o role OIDC do GitHub Actions usado
    pelo workflow de infra, ou as credenciais de quem faz o bootstrap
    inicial): precisa de `ssm:GetParameter`/`GetParameters` nos ARNs
    específicos dos parâmetros da app, e permissão de decrypt na KMS key
    usada pelos `SecureString`.
- **Secrets**: **SSM Parameter Store** (`SecureString`) continua sendo a
  fonte da verdade para `GEMINI_API_KEY` e `SUPABASE_SERVICE_ROLE_KEY`. O
  Terraform lê os valores via data source (`aws_ssm_parameter`, com
  `with_decryption = true`) e os injeta como variáveis de ambiente do
  Lambda (que já são criptografadas em repouso pela própria AWS). Isso
  mantém o cold start rápido e evita chamadas de rede extras a cada
  invocação.
- **Logs**: CloudWatch Logs automático do Lambda — nenhuma configuração
  extra necessária, custo desprezível no volume esperado.
- **State do Terraform**: bucket S3 + tabela DynamoDB de lock, criados uma
  única vez via bootstrap manual (necessário porque o CI roda
  `terraform apply` repetidamente — sem state remoto, cada execução do CI
  começaria do zero e tentaria recriar os recursos).

### Alternativas consideradas e descartadas

| Opção                                       | Custo estimado/mês                          | Motivo da rejeição                                                                                                                                                          |
| ------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ECS Fargate + Application Load Balancer     | ~US$ 27-35                                  | ALB cobra uma taxa fixa por hora (~US$16-20) independente do tráfego — dominante e desnecessária para um app de poucas requisições.                                         |
| EC2 `t4g.micro` sem ALB, gerenciado com pm2 | US$ 0 (free tier 12 meses) / ~US$3-7 depois | Mais barato que Fargate+ALB, mas exige gerenciar o processo e o SO manualmente; Lambda é mais barato ainda e sem esse ônus operacional, dado o tráfego baixíssimo esperado. |
| AWS App Runner                              | ~US$ 5-15                                   | Ainda mantém uma instância sempre ativa (custo de "provisionado" mesmo ocioso); Lambda com tráfego baixo tende a zero.                                                      |

### Custo estimado

**US$ 0-1/mês** — dentro (ou muito próximo) do free tier permanente da
Lambda (1 milhão de requisições + 400.000 GB-segundos de computação
grátis por mês, para sempre, não apenas nos primeiros 12 meses). SSM
Parameter Store (parâmetros `standard`) e CloudWatch Logs no volume
esperado também ficam dentro do free tier ou custam centavos. S3 +
DynamoDB do state do Terraform: custo irrisório (uso muito pequeno).

Custos fora da AWS, não cobertos aqui: API do Gemini (pay-per-token) e
Supabase (free tier deve cobrir o volume esperado).

## Parte 3 — CI/CD (GitHub Actions)

Dois workflows separados, para que deploys de código (frequentes) não
dependam de rodar Terraform a cada push:

1. **Deploy de aplicação** (a cada push na `main` que altere código da app):
   - `bun install && bun run build` (gera a saída do preset `aws-lambda` do
     Nitro).
   - Zipa a saída do build.
   - `aws lambda update-function-code` para atualizar o código da função
     Lambda diretamente — mais rápido e simples que rodar `terraform apply`
     a cada commit.
2. **Infra** (só quando arquivos `.tf` mudam): `terraform plan`/`apply`,
   criando/atualizando a função Lambda, a Function URL, as roles IAM e as
   variáveis de ambiente lidas do SSM. O recurso `aws_lambda_function` usa
   `lifecycle { ignore_changes = [filename, source_code_hash] }` (ou
   equivalente) para que um `apply` de infraestrutura não reverta um deploy
   de código feito pelo workflow 1.

**Autenticação**: GitHub Actions autentica na AWS via **OIDC** (identity
federation), sem access key fixa gravada como secret do repositório — é a
prática recomendada atual e evita ter uma credencial estática de longa
duração para vazar.

## Resumo das decisões

| Decisão        | Escolha                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------- |
| Compute AWS    | AWS Lambda + Function URL                                                                |
| Empacotamento  | zip (sem Docker/ECR)                                                                     |
| Provedor de IA | Google Gemini, chamada direta (mesmo modelo `gemini-2.5-flash`)                          |
| IaC            | Terraform, state remoto em S3 + DynamoDB                                                 |
| Secrets        | SSM Parameter Store (`SecureString`), injetados como env var do Lambda pelo Terraform    |
| CI/CD          | GitHub Actions, workflows separados para deploy de código e infra, autenticação via OIDC |
| Domínio/HTTPS  | Nenhum domínio próprio — HTTPS via Function URL padrão da AWS                            |
| Cloudflare     | Removido por completo (`wrangler.jsonc`, `@cloudflare/vite-plugin`)                      |

## Próximos passos

Este documento serve de base para o plano de implementação detalhado
(skill `writing-plans`), que deve cobrir, nesta ordem: (1) mudanças locais
da Parte 1 e validação de que `bun run dev` funciona sem Lovable, (2)
bootstrap manual do state do Terraform (S3 + DynamoDB), (3) módulos
Terraform da Parte 2, (4) workflows de CI/CD da Parte 3, (5) primeiro
deploy validado ponta a ponta.
