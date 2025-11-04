# Auto-write VITE_API_BASE_URL into frontend-vue/.env* after backend is deployed
resource "null_resource" "write_frontend_env" {
  triggers = {
    backend_url = google_cloud_run_v2_service.backend.uri
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    command = <<-EOT
      set -euo pipefail
      FRONTEND_DIR="${path.module}/../frontend-vue"

      if [ ! -d "$FRONTEND_DIR" ]; then
        echo "找不到前端目錄：$FRONTEND_DIR"
        echo "請修改 terraform/env-writer.tf 內的 FRONTEND_DIR"
        exit 1
      fi

      echo "寫入前端環境變數檔..."
      echo "VITE_API_BASE_URL=${google_cloud_run_v2_service.backend.uri}" > "$FRONTEND_DIR/.env.production"
      echo "VITE_API_BASE_URL=${google_cloud_run_v2_service.backend.uri}" > "$FRONTEND_DIR/.env"

      echo "完成 ✅"
      echo "  - $FRONTEND_DIR/.env.production"
      echo "  - $FRONTEND_DIR/.env"
    EOT
  }

  depends_on = [google_cloud_run_v2_service.backend]
}
