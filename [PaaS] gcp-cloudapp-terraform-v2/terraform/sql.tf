resource "google_sql_database_instance" "mysql" {
  name             = var.db_instance_name
  database_version = "MYSQL_8_0"
  region           = var.region

  settings {
    tier              = var.db_tier
    availability_type = "ZONAL"

    backup_configuration {
      enabled = false
    }

    disk_type = "PD_HDD"
    disk_size = var.db_disk_size_gb

    ip_configuration {
      ipv4_enabled = true

      dynamic "authorized_networks" {
        for_each = var.authorized_networks
        content {
          name  = "cidr-${authorized_networks.value}"
          value = authorized_networks.value
        }
      }
    }
  }
}
