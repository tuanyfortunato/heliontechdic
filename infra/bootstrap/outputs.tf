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
