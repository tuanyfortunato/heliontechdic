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
