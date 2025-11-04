variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region for Cloud Run & Artifact Registry"
  type        = string
  default     = "us-central1"
}

variable "location" {
  description = "Multi-purpose location (often same as region)"
  type        = string
  default     = "us-central1"
}

variable "backend_image" {
  description = "Artifact Registry image for backend (e.g., us-central1-docker.pkg.dev/PROJECT/REPO/backend:TAG)"
  type        = string
}

variable "frontend_image" {
  description = "Artifact Registry image for frontend"
  type        = string
}

variable "db_instance_name" {
  description = "Cloud SQL instance name"
  type        = string
  default     = "app-db"
}

variable "db_tier" {
  description = "Cloud SQL machine type tier"
  type        = string
  default     = "db-f1-micro"
}

variable "db_disk_size_gb" {
  description = "Disk size in GB"
  type        = number
  default     = 10
}

variable "authorized_networks" {
  description = "List of authorized public CIDRs for Cloud SQL"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "backend_env" {
  description = "Environment variables for backend Cloud Run container"
  type        = map(string)
  default     = {}
}

variable "frontend_env" {
  description = "Environment variables for frontend Cloud Run container"
  type        = map(string)
  default     = {}
}
