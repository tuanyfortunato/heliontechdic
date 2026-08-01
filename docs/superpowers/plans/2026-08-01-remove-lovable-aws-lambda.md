# Remove Lovable Dependency & Deploy to AWS Lambda — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the HELION app runnable entirely outside the Lovable environment (local dev + build) and deploy it to AWS on AWS Lambda, provisioned with Terraform and deployed via GitHub Actions, at minimum realistic cost.

**Architecture:** TanStack Start (React 19, Vite 7, Nitro) stays as-is architecturally; only the Vite config, the Cloudflare-specific server entry, and the AI gateway call change. Nitro's `aws-lambda` preset replaces the Cloudflare Workers preset, producing a zip-deployable Lambda handler invoked through a public Lambda Function URL (no API Gateway, no ALB, no VPC). Terraform manages all AWS resources across two root modules (`infra/bootstrap` applied once by hand, `infra/app` applied by CI); GitHub Actions authenticates to AWS via OIDC (no static keys) and runs two independent workflows — one that ships app code on every push, one that applies infra changes only when Terraform files change.

**Tech Stack:** TanStack Start, Vite 7, Nitro (aws-lambda preset), React 19, Bun, Vitest (new), Terraform ~> 1.5, AWS Lambda/IAM/SSM/CloudWatch/S3/DynamoDB, GitHub Actions with OIDC.

## Global Constraints

- AI model stays `gemini-2.5-flash` (same model, called directly against Google's OpenAI-compatible endpoint — the `google/` prefix is dropped because that was a gateway-routing convention specific to the Lovable/OpenRouter-style proxy, not part of the model's own name).
- No custom domain, no ACM certificate — HTTPS is served by the AWS-managed certificate on the Lambda Function URL.
- No VPC — the Lambda function runs outside any VPC (Supabase and the Gemini API are both public HTTPS endpoints).
- Deployment package is a **zip**, not a container image — no Docker, no ECR.
- GitHub Actions authenticates to AWS via **OIDC** — no long-lived AWS access keys stored as repo secrets.
- Secrets (`GEMINI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) live in **SSM Parameter Store** as `SecureString`, created once by hand, and are read by Terraform at `apply` time and injected as Lambda **environment variables** — the app itself makes no AWS API calls at runtime to fetch secrets.
- Terraform state is remote: S3 bucket + DynamoDB lock table, created once via `infra/bootstrap` (required because CI runs `terraform apply` repeatedly and needs shared, locked state).
- AWS region: `us-east-1` (default, overridable via Terraform variable — no explicit region requirement was given, this is the reasonable low-cost default consistent with the earlier cost estimates in the design spec).
- Lambda runtime: `nodejs22.x`.
- Lambda Function URL: `authorization_type = "NONE"` (public site, no IAM auth) and `invoke_mode = "RESPONSE_STREAM"` (required to match `awsLambda: { streaming: true }` in the Nitro preset — the default `BUFFERED` mode would break SSR streaming).
- Resource/project name prefix: `helion`.
- GitHub repo (for the OIDC trust policy): `tuanyfortunato/heliontechdic`.
- Design reference: `docs/superpowers/specs/2026-08-01-remove-lovable-aws-lambda-design.md`.

## Prerequisites (one-time machine setup, not a task)

The engineer's machine needs, before starting Task 1:

- **Bun** — not currently installed on this machine. Install with:
  ```powershell
  powershell -c "irm bun.sh/install.ps1|iex"
  ```
  Then open a new shell and confirm: `bun --version`.
- **AWS CLI v2**, **Terraform >= 1.5**, **GitHub CLI (`gh`)** — already installed and confirmed on this machine (`aws-cli/2.35.22`, `Terraform v1.15.8`, `gh 2.96.0`). If missing on another machine, install from the official AWS/HashiCorp/GitHub docs.
- AWS credentials configured for an account you control: `aws configure` (or `aws sso login` if using SSO), then confirm with `aws sts get-caller-identity`.
- `gh auth login` (needed in Task 8/9 to set repo variables).

---

## Task 1: Replace Lovable's Vite config, remove Cloudflare deploy target

**Files:**
- Modify: `vite.config.ts`
- Modify: `package.json:59` (remove `@lovable.dev/vite-tanstack-config` and `@cloudflare/vite-plugin` from `dependencies`/`devDependencies`)
- Modify: `bunfig.toml`
- Delete: `wrangler.jsonc`
- Delete: `.lovable/` (entire directory)

**Interfaces:**
- Produces: a `vite.config.ts` whose Nitro preset (`aws-lambda`) is consumed by Task 6/7 (the Terraform Lambda resource expects the build output this preset produces) and by Task 8 (the CI build step).

- [ ] **Step 1: Delete the Lovable-only files**

```bash
rm -rf .lovable
rm wrangler.jsonc
```

- [ ] **Step 2: Remove the bunfig.toml exclusion line**

Edit `bunfig.toml` from:

```toml
[install]
# 24h supply-chain guard: skip package versions published less than a day ago.
minimumReleaseAge = 86400
# Each entry bypasses the 24h guard for one package — confirm with the user
# before adding any.
minimumReleaseAgeExcludes = ["@lovable.dev/vite-tanstack-config"]
```

to:

```toml
[install]
# 24h supply-chain guard: skip package versions published less than a day ago.
minimumReleaseAge = 86400
```

- [ ] **Step 3: Remove the two Lovable/Cloudflare dependencies from package.json**

In `package.json`, remove this line from `"dependencies"`:

```json
    "@cloudflare/vite-plugin": "^1.25.5",
```

and this line from `"devDependencies"`:

```json
    "@lovable.dev/vite-tanstack-config": "^1.7.0",
```

- [ ] **Step 4: Rewrite vite.config.ts**

Replace the entire contents of `vite.config.ts` with:

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
    // nitro@3's vite plugin only merges `config` into Nitro's own options
    // (pluginConfig.config, per node_modules/nitro/dist/_chunks/plugin.mjs) —
    // top-level `preset`/`awsLambda` are silently ignored and the build falls
    // back to the node-server preset, which has no `handler` export.
    nitro({ config: { preset: "aws-lambda", awsLambda: { streaming: true } } }),
    viteReact(),
  ],
});
```

- [ ] **Step 5: Reinstall dependencies**

```bash
bun install
```

Expected: completes without error; `bun.lock` updates (the two removed packages disappear, and every dependency Lovable's private registry mirror had resolved now resolves against the public npm registry — the lockfile diff will look large, that's expected and safe per the design doc).

- [ ] **Step 6: Verify the dev server boots without any Lovable package**

```bash
bun run dev &
sleep 3
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000
kill %1
```

Expected: prints `200`.

- [ ] **Step 7: Commit**

```bash
git add vite.config.ts package.json bun.lock bunfig.toml
git add -u wrangler.jsonc .lovable
git commit -m "chore: replace Lovable vite config with explicit config, drop Cloudflare target"
```

---

## Task 2: Remove the Cloudflare Workers server entry and its dead-code helper

**Files:**
- Delete: `src/server.ts`
- Delete: `src/lib/error-capture.ts`
- Test: manual build verification (no dedicated test framework covers this file removal — see Step 2)

**Interfaces:**
- Consumes: `src/start.ts`'s existing `errorMiddleware` (unchanged) — confirmed to already cover the friendly-error-page behavior that `server.ts` used to provide via its own wrapper.
- Produces: nothing new; this task only removes dead code so later tasks build cleanly.

- [ ] **Step 1: Confirm nothing else references these files**

```bash
grep -rn "error-capture\|from \"./server\"\|from \"../server\"" src/ --include="*.ts" --include="*.tsx"
```

Expected: no output (the only prior references were in `wrangler.jsonc` and the old `vite.config.ts` comment, both already gone after Task 1).

- [ ] **Step 2: Delete the files**

```bash
rm src/server.ts src/lib/error-capture.ts
```

- [ ] **Step 3: Verify the app still builds**

```bash
bun run build
```

Expected: exits `0`. This is the "test" for this task — the Nitro `aws-lambda` preset build must succeed with no dangling import to the removed files, and it produces `.output/server/index.mjs` (used starting in Task 6).

- [ ] **Step 4: Verify dev server still works and error handling still renders the friendly page**

```bash
bun run dev &
sleep 3
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000
kill %1
```

Expected: `200` (same check as Task 1 — confirms removing the two files didn't break the running app).

- [ ] **Step 5: Commit**

```bash
git add -u src/server.ts src/lib/error-capture.ts
git commit -m "chore: remove Cloudflare Workers server entry (dead code after dropping wrangler)"
```

---

## Task 3: Add Vitest, make the AI gateway call testable, swap Lovable AI Gateway for direct Gemini call

**Files:**
- Modify: `package.json` (add `vitest` devDependency, add `"test": "vitest run"` script)
- Create: `vitest.config.ts`
- Modify: `src/lib/helion.functions.ts:1-5,63-82`
- Create: `src/lib/helion.functions.test.ts`

**Interfaces:**
- Produces: `export async function callGateway(body: unknown, fetchImpl: typeof fetch = fetch): Promise<string>` — exported (was module-private) so it can be unit-tested and so its signature is visible to anyone reading this file later. `humanize` and `deepDive` (already exported, unchanged signatures) keep calling `callGateway(body)` with no second argument, so runtime behavior for them is unaffected.

- [ ] **Step 1: Add Vitest**

Add to `"devDependencies"` in `package.json`:

```json
    "vitest": "^3.2.4",
```

Add to `"scripts"` in `package.json`:

```json
    "test": "vitest run",
```

Run:

```bash
bun install
```

- [ ] **Step 2: Create vitest.config.ts**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
});
```

- [ ] **Step 3: Write the failing tests**

Create `src/lib/helion.functions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callGateway } from "./helion.functions";

describe("callGateway", () => {
  const originalKey = process.env.GEMINI_API_KEY;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  });

  it("throws when GEMINI_API_KEY is not configured", async () => {
    delete process.env.GEMINI_API_KEY;
    await expect(callGateway({ foo: "bar" })).rejects.toThrow(
      "GEMINI_API_KEY not configured",
    );
  });

  it("calls the Gemini OpenAI-compatible endpoint with the API key and returns the message content", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "hello world" } }] }),
    });

    const result = await callGateway(
      { model: "gemini-2.5-flash" },
      fetchMock as unknown as typeof fetch,
    );

    expect(result).toBe("hello world");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer test-key",
        }),
      }),
    );
  });

  it("throws a specific message on HTTP 429", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    });

    await expect(
      callGateway({}, fetchMock as unknown as typeof fetch),
    ).rejects.toThrow("Limite de requisições");
  });

  it("throws a specific message on HTTP 402", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      text: async () => "payment required",
    });

    await expect(
      callGateway({}, fetchMock as unknown as typeof fetch),
    ).rejects.toThrow("Créditos esgotados");
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

```bash
bun run test
```

Expected: FAIL — `callGateway` is not exported yet from `src/lib/helion.functions.ts`, so the import errors out.

- [ ] **Step 5: Swap the gateway URL/model/auth and export callGateway**

In `src/lib/helion.functions.ts`, replace lines 1–5:

```ts
import { createServerFn } from "@tanstack/react-start";

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MODEL = "google/gemini-2.5-flash";
```

with:

```ts
import { createServerFn } from "@tanstack/react-start";

const GATEWAY_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const MODEL = "gemini-2.5-flash";
```

Then replace the `callGateway` function (currently lines 63–82):

```ts
async function callGateway(body: unknown): Promise<string> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");
  const res = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429) throw new Error("Limite de requisições. Tente novamente em instantes.");
    if (res.status === 402) throw new Error("Créditos esgotados no workspace Lovable AI.");
    throw new Error(`Gateway ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}
```

with:

```ts
export async function callGateway(
  body: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");
  const res = await fetchImpl(GATEWAY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429) throw new Error("Limite de requisições. Tente novamente em instantes.");
    if (res.status === 402) throw new Error("Créditos esgotados na conta do Gemini.");
    throw new Error(`Gateway ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
bun run test
```

Expected: PASS (4 tests).

- [ ] **Step 7: Update .env's key name locally so bun run dev keeps working**

Rename `LOVABLE_API_KEY` to `GEMINI_API_KEY` in your local `.env`, with a real Gemini API key (get one at https://aistudio.google.com/apikey).

- [ ] **Step 8: Manually verify one real end-to-end call**

```bash
bun run dev &
sleep 3
```

Open `http://localhost:3000` in a browser, type a real term (e.g. "API") into the form, and submit. Expected: a real Gemini-generated explanation renders on the page (confirms the direct Gemini call works end-to-end, not just the unit-level mock in Step 6). Then:

```bash
kill %1
```

- [ ] **Step 9: Commit**

```bash
git add package.json bun.lock vitest.config.ts src/lib/helion.functions.ts src/lib/helion.functions.test.ts
git commit -m "feat: call Gemini directly instead of Lovable AI Gateway, add Vitest coverage"
```

---

## Task 4: Remove cosmetic Lovable references, add .env.example, stop tracking .env

**Files:**
- Modify: `src/routes/__root.tsx:82`
- Modify: `src/integrations/supabase/client.ts:16`
- Modify: `src/integrations/supabase/client.server.ts:15`
- Modify: `src/integrations/supabase/auth-middleware.ts:19`
- Create: `.env.example`
- Modify: `.gitignore`
- Delete (from git tracking only): `.env`

**Interfaces:**
- None — this task only touches strings/docs, no exported symbols change.

- [ ] **Step 1: Remove the Lovable Twitter tag**

In `src/routes/__root.tsx`, remove this line (currently line 82):

```tsx
      { name: "twitter:site", content: "@Lovable" },
```

- [ ] **Step 2: Generic-ize the Supabase error messages**

In `src/integrations/supabase/client.ts`, `src/integrations/supabase/client.server.ts`, and `src/integrations/supabase/auth-middleware.ts`, each has a line reading:

```ts
    const message = `Missing Supabase environment variable(s): ${missing.join(', ')}. Connect Supabase in Lovable Cloud.`;
```

Replace all three occurrences with:

```ts
    const message = `Missing Supabase environment variable(s): ${missing.join(', ')}. Set them in your .env file (see .env.example).`;
```

- [ ] **Step 3: Create .env.example**

```
# Google Gemini API key for the humanize/deepDive server functions.
# Get one at https://aistudio.google.com/apikey
GEMINI_API_KEY=

# Supabase project — see https://supabase.com/dashboard -> Project Settings -> API
VITE_SUPABASE_URL=
SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_PUBLISHABLE_KEY=
VITE_SUPABASE_PROJECT_ID=

# Server-side only — bypasses Row Level Security. Never expose to client code.
SUPABASE_SERVICE_ROLE_KEY=
```

- [ ] **Step 4: Stop tracking .env and ignore it going forward**

`.env` is currently committed to git (confirmed via `git ls-files`), which is the exact anti-pattern the migration is meant to fix — secrets belong in SSM Parameter Store from Task 5 onward, not in a versioned file.

Add to `.gitignore` (append to the "Wrangler / Cloudflare" section area, or anywhere in the file):

```
.env
```

Then untrack it (this keeps the file on disk locally, it just stops being version-controlled):

```bash
git rm --cached .env
```

- [ ] **Step 5: Verify the app still boots with the untracked .env**

```bash
bun run dev &
sleep 3
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000
kill %1
```

Expected: `200` (confirms `.env` is still being read locally from disk even though git no longer tracks it).

- [ ] **Step 6: Commit**

```bash
git add .gitignore .env.example src/routes/__root.tsx src/integrations/supabase/client.ts src/integrations/supabase/client.server.ts src/integrations/supabase/auth-middleware.ts
git commit -m "chore: remove cosmetic Lovable references, stop tracking .env, add .env.example"
```

(The `.env` removal from Step 4's `git rm --cached .env` is already staged and will be included in this same commit.)

This completes Phase A — at this point `bun install && bun run dev` works with zero Lovable dependency, matching the design spec's Part 1 success criterion.

---

## Task 5: Terraform bootstrap — remote state backend + GitHub OIDC roles (applied once, by hand)

**Files:**
- Create: `infra/bootstrap/main.tf`
- Create: `infra/bootstrap/variables.tf`
- Create: `infra/bootstrap/outputs.tf`

**Interfaces:**
- Produces (Terraform outputs, consumed by Task 6's backend config and Task 8/9's GitHub Actions repo variables): `state_bucket` (string), `lock_table` (string), `deploy_app_role_arn` (string), `deploy_infra_role_arn` (string).

This module is applied **manually, once**, with your own local AWS credentials — it is never run from CI (it creates the very state backend and IAM roles that CI needs to exist first).

- [ ] **Step 1: Create infra/bootstrap/variables.tf**

```hcl
variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "project_name" {
  type    = string
  default = "helion"
}

variable "github_repo" {
  description = "GitHub repo in owner/name form, scopes the OIDC trust policy"
  type        = string
  default     = "tuanyfortunato/heliontechdic"
}
```

- [ ] **Step 2: Create infra/bootstrap/main.tf**

```hcl
terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# --- Remote state backend ---

resource "aws_s3_bucket" "tf_state" {
  bucket = "${var.project_name}-terraform-state"
}

resource "aws_s3_bucket_versioning" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tf_state" {
  bucket                  = aws_s3_bucket.tf_state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_dynamodb_table" "tf_lock" {
  name         = "${var.project_name}-terraform-lock"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }
}

# --- GitHub OIDC provider + roles ---

data "tls_certificate" "github" {
  url = "https://token.actions.githubusercontent.com/.well-known/openid-configuration"
}

resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.github.certificates[0].sha1_fingerprint]
}

data "aws_iam_policy_document" "github_oidc_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:*"]
    }
  }
}

# Narrow role: only allowed to push new code to the existing Lambda function.
resource "aws_iam_role" "deploy_app" {
  name               = "${var.project_name}-gha-deploy-app"
  assume_role_policy = data.aws_iam_policy_document.github_oidc_trust.json
}

data "aws_iam_policy_document" "deploy_app_permissions" {
  statement {
    effect = "Allow"
    actions = [
      "lambda:UpdateFunctionCode",
      "lambda:GetFunction",
      "lambda:GetFunctionConfiguration",
    ]
    resources = ["arn:aws:lambda:${var.aws_region}:*:function:${var.project_name}-*"]
  }
}

resource "aws_iam_role_policy" "deploy_app" {
  name   = "${var.project_name}-deploy-app"
  role   = aws_iam_role.deploy_app.id
  policy = data.aws_iam_policy_document.deploy_app_permissions.json
}

# Broader role: allowed to manage the app's infra (Lambda, its exec role, logs, read SSM,
# read/write the state backend). Scoped by action, not narrowed to a resource ARN prefix,
# because Terraform itself needs to inspect/manage the IAM role it creates for Lambda and
# perfect least-privilege here would need constant upkeep for a single small project —
# an accepted simplification given this is one project, not a shared account.
resource "aws_iam_role" "deploy_infra" {
  name               = "${var.project_name}-gha-deploy-infra"
  assume_role_policy = data.aws_iam_policy_document.github_oidc_trust.json
}

data "aws_iam_policy_document" "deploy_infra_permissions" {
  statement {
    effect = "Allow"
    actions = [
      "lambda:*",
      "iam:GetRole",
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:PutRolePolicy",
      "iam:GetRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:PassRole",
      "iam:TagRole",
      "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "logs:CreateLogGroup",
      "logs:DeleteLogGroup",
      "logs:PutRetentionPolicy",
      "logs:DescribeLogGroups",
      "logs:TagResource",
      "logs:ListTagsForResource",
      "ssm:GetParameter",
      "ssm:GetParameters",
      "s3:GetObject",
      "s3:PutObject",
      "s3:ListBucket",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:DeleteItem",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "deploy_infra" {
  name   = "${var.project_name}-deploy-infra"
  role   = aws_iam_role.deploy_infra.id
  policy = data.aws_iam_policy_document.deploy_infra_permissions.json
}
```

- [ ] **Step 3: Create infra/bootstrap/outputs.tf**

```hcl
output "state_bucket" {
  value = aws_s3_bucket.tf_state.bucket
}

output "lock_table" {
  value = aws_dynamodb_table.tf_lock.name
}

output "deploy_app_role_arn" {
  value = aws_iam_role.deploy_app.arn
}

output "deploy_infra_role_arn" {
  value = aws_iam_role.deploy_infra.arn
}
```

- [ ] **Step 4: Validate and plan**

```bash
cd infra/bootstrap
terraform init
terraform validate
terraform plan
```

Expected: `terraform validate` reports `Success!`; `terraform plan` shows resources to add: `aws_s3_bucket`, `aws_s3_bucket_versioning`, `aws_s3_bucket_server_side_encryption_configuration`, `aws_s3_bucket_public_access_block`, `aws_dynamodb_table`, `aws_iam_openid_connect_provider`, `aws_iam_role` (x2), `aws_iam_role_policy` (x2) — 10 resources total, 0 to change, 0 to destroy.

- [ ] **Step 5: Apply**

```bash
terraform apply
```

Type `yes` when prompted. Expected: `Apply complete! Resources: 10 added, 0 changed, 0 destroyed.`, followed by the four outputs.

- [ ] **Step 6: Verify the resources exist in AWS**

```bash
terraform output -raw state_bucket
aws s3 ls | grep helion-terraform-state
aws dynamodb describe-table --table-name helion-terraform-lock --query "Table.TableStatus"
```

Expected: bucket name printed and found in `s3 ls`; table status `"ACTIVE"`.

- [ ] **Step 7: Record the outputs for later tasks**

```bash
terraform output
```

Keep this output visible — Task 6 needs `state_bucket`/`lock_table` for the backend config, and Task 8/9 need `deploy_app_role_arn`/`deploy_infra_role_arn` for the GitHub repo variables. (Nothing here is secret — these are resource identifiers/ARNs, not credentials.)

- [ ] **Step 8: Commit**

```bash
cd ../..
git add infra/bootstrap
git commit -m "feat: add Terraform bootstrap (remote state backend, GitHub OIDC roles)"
```

---

## Task 6: Terraform app module — Lambda execution role + Lambda function (first manual build & apply)

**Files:**
- Create: `infra/app/backend.tf`
- Create: `infra/app/variables.tf`
- Create: `infra/app/main.tf`
- Create: `infra/app/terraform.tfvars.example`

**Interfaces:**
- Consumes: `state_bucket`/`lock_table` outputs from Task 5.
- Produces: `aws_lambda_function.app` (Terraform resource name, consumed by Task 7's Function URL/permission and by Task 8's `aws lambda update-function-code` calls via its `function_name` output).

- [ ] **Step 1: Create infra/app/backend.tf**

Replace `helion-terraform-state` / `helion-terraform-lock` below only if Task 5's actual bucket/table names differ (they shouldn't, given the fixed `project_name` default):

```hcl
terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket         = "helion-terraform-state"
    key            = "app/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "helion-terraform-lock"
    encrypt        = true
  }
}

provider "aws" {
  region = var.aws_region
}
```

- [ ] **Step 2: Create infra/app/variables.tf**

```hcl
variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "project_name" {
  type    = string
  default = "helion"
}

variable "lambda_zip_path" {
  description = "Path to the built Lambda deployment zip, relative to infra/app"
  type        = string
  default     = "../../.output/lambda.zip"
}

variable "supabase_url" {
  description = "Supabase project URL — not secret, safe as a plain variable"
  type        = string
}

variable "supabase_publishable_key" {
  description = "Supabase anon/publishable key — not secret, safe as a plain variable"
  type        = string
}
```

- [ ] **Step 3: Create infra/app/terraform.tfvars.example**

```hcl
supabase_url             = "https://fsfewjupdgrovopflqgb.supabase.co"
supabase_publishable_key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZzZmV3anVwZGdyb3ZvcGZscWdiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0OTc3ODMsImV4cCI6MjA5NTA3Mzc4M30.6JTcVa96JBDMkbK1kXYh3DF32RS4t6_mmKOrSSU6wwk"
```

Copy this to a real (gitignored) `terraform.tfvars` before applying:

```bash
cp infra/app/terraform.tfvars.example infra/app/terraform.tfvars
```

Add to `.gitignore`:

```
infra/app/terraform.tfvars
```

- [ ] **Step 4: Create the two SSM SecureString parameters by hand (one-time)**

```bash
aws ssm put-parameter --name "/helion/gemini_api_key" --type SecureString --value "<your real Gemini API key>"
aws ssm put-parameter --name "/helion/supabase_service_role_key" --type SecureString --value "<your real Supabase service role key>"
```

- [ ] **Step 5: Create infra/app/main.tf**

```hcl
data "aws_iam_policy_document" "lambda_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda_exec" {
  name               = "${var.project_name}-lambda-exec"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "lambda_basic_execution" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_ssm_parameter" "gemini_api_key" {
  name            = "/${var.project_name}/gemini_api_key"
  with_decryption = true
}

data "aws_ssm_parameter" "supabase_service_role_key" {
  name            = "/${var.project_name}/supabase_service_role_key"
  with_decryption = true
}

resource "aws_lambda_function" "app" {
  function_name = "${var.project_name}-app"
  role          = aws_iam_role.lambda_exec.arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  timeout       = 15
  memory_size   = 512

  filename         = var.lambda_zip_path
  source_code_hash = filebase64sha256(var.lambda_zip_path)

  environment {
    variables = {
      GEMINI_API_KEY            = data.aws_ssm_parameter.gemini_api_key.value
      SUPABASE_SERVICE_ROLE_KEY = data.aws_ssm_parameter.supabase_service_role_key.value
      SUPABASE_URL              = var.supabase_url
      SUPABASE_PUBLISHABLE_KEY  = var.supabase_publishable_key
    }
  }

  lifecycle {
    # Code is deployed by the GitHub Actions app-deploy workflow (Task 8) via
    # `aws lambda update-function-code`, not by Terraform after this first apply —
    # this stops routine `terraform apply` runs (e.g. Task 7, or any future infra
    # change) from reverting to whatever zip happens to be on disk at apply time.
    ignore_changes = [filename, source_code_hash]
  }
}

output "function_name" {
  value = aws_lambda_function.app.function_name
}

output "lambda_exec_role_arn" {
  value = aws_iam_role.lambda_exec.arn
}
```

- [ ] **Step 6: Build and package the first deployable zip**

From the project root (using PowerShell here since this Windows machine has no `zip` CLI on PATH; the GitHub Actions workflow in Task 8 runs on a Linux runner where `zip` is available by default, so it uses that instead):

```powershell
bun run build
Compress-Archive -Path ".output/server/*" -DestinationPath ".output/lambda.zip" -Force
```

Expected: `.output/lambda.zip` exists.

- [ ] **Step 7: Init, validate, plan**

```bash
cd infra/app
terraform init
terraform validate
terraform plan
```

Expected: `terraform validate` → `Success!`. `terraform plan` shows 5 resources to add (`aws_iam_role`, `aws_iam_role_policy_attachment`, `aws_lambda_function`, plus the two `data` reads don't count as adds) — confirm no destructive changes are planned.

- [ ] **Step 8: Apply**

```bash
terraform apply
```

Type `yes`. Expected: `Apply complete! Resources: 3 added, 0 changed, 0 destroyed.`

- [ ] **Step 9: Verify the function runs — direct invoke test**

```bash
aws lambda invoke --function-name helion-app --payload "{}" --cli-binary-format raw-in-base64-out /tmp/lambda-out.json
cat /tmp/lambda-out.json
```

Expected: the invoke succeeds (no `FunctionError` field in the CLI's own output) and `/tmp/lambda-out.json` contains a response object (a raw `{}` payload isn't a real Function URL event, so the response may be an error *from the app's own routing*, e.g. a 404 — that's fine here; the goal of this step is confirming the Lambda runtime boots the bundle and executes without crashing at cold start, not a full HTTP round-trip yet).

- [ ] **Step 10: Commit**

```bash
cd ../..
git add infra/app/backend.tf infra/app/variables.tf infra/app/main.tf infra/app/terraform.tfvars.example .gitignore
git commit -m "feat: add Terraform Lambda function + execution role for HELION app"
```

---

## Task 7: Lambda Function URL, CloudWatch log retention, first real end-to-end deploy

**Files:**
- Modify: `infra/app/main.tf`

**Interfaces:**
- Consumes: `aws_lambda_function.app` from Task 6.
- Produces: `function_url` Terraform output (the public HTTPS URL for the app — this is the URL you'll actually open in a browser and the one CI's smoke test, if added later, would target).

- [ ] **Step 1: Add the Function URL, its public-invoke permission, and the log group**

Append to `infra/app/main.tf`:

```hcl
resource "aws_cloudwatch_log_group" "app" {
  name              = "/aws/lambda/${aws_lambda_function.app.function_name}"
  retention_in_days = 14
}

resource "aws_lambda_function_url" "app" {
  function_name      = aws_lambda_function.app.function_name
  authorization_type = "NONE"
  invoke_mode        = "RESPONSE_STREAM"
}

# Required in addition to authorization_type = "NONE" above — without this
# resource-based permission, a public Function URL still returns 403 Forbidden.
resource "aws_lambda_permission" "public_url" {
  statement_id           = "AllowPublicFunctionUrlInvoke"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.app.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

output "function_url" {
  value = aws_lambda_function_url.app.function_url
}
```

- [ ] **Step 2: Plan and apply**

```bash
cd infra/app
terraform plan
```

Expected: 3 resources to add (`aws_cloudwatch_log_group`, `aws_lambda_function_url`, `aws_lambda_permission`), 0 to change, 0 to destroy.

```bash
terraform apply
```

Type `yes`. Expected: `Apply complete! Resources: 3 added, 0 changed, 0 destroyed.`

- [ ] **Step 3: Smoke-test the real public URL**

```bash
URL=$(terraform output -raw function_url)
curl -s -o /dev/null -w "%{http_code}\n" "$URL"
```

Expected: `200`.

- [ ] **Step 4: Verify the AI call works end-to-end through the deployed Lambda**

Open `$URL` in a browser (or use `curl` against whatever form-submit route the app uses), submit a real term (e.g. "API") through the UI, and confirm a real Gemini-generated explanation renders — this proves the SSM-sourced `GEMINI_API_KEY` env var, the direct Gemini call from Task 3, and the Lambda deployment all work together in the real AWS environment, not just locally.

- [ ] **Step 5: Check logs if anything failed**

```bash
aws logs tail /aws/lambda/helion-app --since 5m
```

- [ ] **Step 6: Commit**

```bash
cd ../..
git add infra/app/main.tf
git commit -m "feat: expose HELION app via public Lambda Function URL"
```

This completes Phase B — the app is now live on AWS. Cost at this point: ~US$0–1/month per the design doc's Lambda free-tier analysis.

---

## Task 8: GitHub Actions — app deploy workflow (build, zip, update Lambda code)

**Files:**
- Create: `.github/workflows/deploy-app.yml`

**Interfaces:**
- Consumes: repo variables `AWS_DEPLOY_APP_ROLE_ARN`, `AWS_REGION`, `LAMBDA_FUNCTION_NAME` (set in Step 1 below, from Task 5/6 outputs).

- [ ] **Step 1: Set the GitHub repo variables**

```bash
gh variable set AWS_REGION --body "us-east-1"
gh variable set LAMBDA_FUNCTION_NAME --body "helion-app"
gh variable set AWS_DEPLOY_APP_ROLE_ARN --body "$(cd infra/bootstrap && terraform output -raw deploy_app_role_arn)"
```

- [ ] **Step 2: Create .github/workflows/deploy-app.yml**

```yaml
name: Deploy App

on:
  push:
    branches: [main]
    paths:
      - "src/**"
      - "package.json"
      - "bun.lock"
      - "vite.config.ts"
      - "tsconfig.json"

permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - run: bun install --frozen-lockfile

      - run: bun run build

      - name: Zip Lambda package
        run: |
          cd .output/server
          zip -r ../lambda.zip .

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_DEPLOY_APP_ROLE_ARN }}
          aws-region: ${{ vars.AWS_REGION }}

      - name: Update Lambda function code
        run: |
          aws lambda update-function-code \
            --function-name "${{ vars.LAMBDA_FUNCTION_NAME }}" \
            --zip-file fileb://.output/lambda.zip
```

- [ ] **Step 3: Validate the workflow YAML**

```bash
gh workflow list
```

(This won't show the new workflow until it's pushed and on the default branch — that happens in Task 10's end-to-end check. For now, just confirm the YAML parses:)

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy-app.yml'))" 2>/dev/null && echo "valid YAML" || echo "INVALID YAML"
```

Expected: `valid YAML`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy-app.yml
git commit -m "ci: add GitHub Actions workflow to deploy app code to Lambda on push"
```

---

## Task 9: GitHub Actions — infra workflow (Terraform plan on PR, apply on main)

**Files:**
- Create: `.github/workflows/deploy-infra.yml`

**Interfaces:**
- Consumes: repo variable `AWS_DEPLOY_INFRA_ROLE_ARN` (set in Step 1 below, from Task 5's output).

- [ ] **Step 1: Set the GitHub repo variable**

```bash
gh variable set AWS_DEPLOY_INFRA_ROLE_ARN --body "$(cd infra/bootstrap && terraform output -raw deploy_infra_role_arn)"
```

- [ ] **Step 2: Create .github/workflows/deploy-infra.yml**

```yaml
name: Deploy Infra

on:
  push:
    branches: [main]
    paths:
      - "infra/app/**"
  pull_request:
    paths:
      - "infra/app/**"

permissions:
  id-token: write
  contents: read
  pull-requests: write

jobs:
  terraform:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: infra/app
    steps:
      - uses: actions/checkout@v4

      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: "1.15.8"

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_DEPLOY_INFRA_ROLE_ARN }}
          aws-region: ${{ vars.AWS_REGION }}

      - run: terraform init

      - run: terraform plan -input=false -var="supabase_url=${{ vars.SUPABASE_URL }}" -var="supabase_publishable_key=${{ vars.SUPABASE_PUBLISHABLE_KEY }}"

      - name: Terraform Apply
        if: github.ref == 'refs/heads/main' && github.event_name == 'push'
        run: terraform apply -auto-approve -input=false -var="supabase_url=${{ vars.SUPABASE_URL }}" -var="supabase_publishable_key=${{ vars.SUPABASE_PUBLISHABLE_KEY }}"
```

Note: `infra/app/terraform.tfvars` is gitignored (Task 6, Step 3) and local-only — CI never reads it. Since `supabase_url`/`supabase_publishable_key` aren't secret, this workflow instead passes them as `-var` flags sourced from the two repo variables set in Step 3 below.

- [ ] **Step 3: Set the two additional repo variables**

```bash
gh variable set SUPABASE_URL --body "https://fsfewjupdgrovopflqgb.supabase.co"
gh variable set SUPABASE_PUBLISHABLE_KEY --body "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZzZmV3anVwZGdyb3ZvcGZscWdiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0OTc3ODMsImV4cCI6MjA5NTA3Mzc4M30.6JTcVa96JBDMkbK1kXYh3DF32RS4t6_mmKOrSSU6wwk"
```

- [ ] **Step 4: Validate the workflow YAML**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy-infra.yml'))" 2>/dev/null && echo "valid YAML" || echo "INVALID YAML"
```

Expected: `valid YAML`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy-infra.yml
git commit -m "ci: add GitHub Actions workflow to plan/apply Terraform infra changes"
```

---

## Task 10: End-to-end CI validation

**Files:** none (verification-only task).

- [ ] **Step 1: Push everything to main and confirm the app-deploy workflow fires**

```bash
git push origin main
gh run list --workflow=deploy-app.yml --limit 1
gh run watch
```

Expected: the run referenced by `gh run watch` finishes with conclusion `success`.

- [ ] **Step 2: Confirm the site still responds after the CI-driven deploy**

```bash
cd infra/app
URL=$(terraform output -raw function_url)
cd ../..
curl -s -o /dev/null -w "%{http_code}\n" "$URL"
```

Expected: `200`.

- [ ] **Step 3: Make a trivial infra change to trigger the infra workflow via a PR**

```bash
git checkout -b test/infra-workflow
```

In `infra/app/main.tf`, change:

```hcl
  retention_in_days = 14
```

to:

```hcl
  retention_in_days = 30
```

```bash
git add infra/app/main.tf
git commit -m "chore: bump log retention to 30 days (CI workflow smoke test)"
git push -u origin test/infra-workflow
gh pr create --title "Bump log retention (CI smoke test)" --body "Verifies the deploy-infra workflow runs terraform plan on PRs."
gh pr checks --watch
```

Expected: the `terraform` job succeeds, and its log shows a `terraform plan` with `1 to change` (the log group's retention).

- [ ] **Step 4: Merge and confirm apply runs**

```bash
gh pr merge --squash --delete-branch
gh run list --workflow=deploy-infra.yml --limit 1
gh run watch
```

Expected: conclusion `success`, and the run's log shows `terraform apply` completed with `1 changed`.

- [ ] **Step 5: Final confirmation**

```bash
aws logs describe-log-groups --log-group-name-prefix /aws/lambda/helion-app --query "logGroups[0].retentionInDays"
```

Expected: `30`.

This completes Phase C. The app is now fully deployed to AWS Lambda at minimum cost, with no Lovable dependency anywhere, and both code and infra changes deploy automatically via GitHub Actions on every push to `main`.
