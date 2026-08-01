terraform {
  # >= 1.10 required for native S3 state locking (`use_lockfile`), used
  # instead of a DynamoDB lock table -- see infra/app/backend.tf.
  required_version = ">= 1.10"
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
      "s3:DeleteObject", # native S3 lockfile is created and removed per apply
      "s3:ListBucket",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "deploy_infra" {
  name   = "${var.project_name}-deploy-infra"
  role   = aws_iam_role.deploy_infra.id
  policy = data.aws_iam_policy_document.deploy_infra_permissions.json
}
