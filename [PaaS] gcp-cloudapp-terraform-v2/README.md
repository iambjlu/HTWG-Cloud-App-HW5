# Infra for Cloud Run + Cloud SQL (Shared Core) — Terraform

> 重點：**Shared Core (`db-f1-micro`)**、**不變更 root 密碼**、**Cloud Run 前後端**一次部署。  
> 另外已內建：**後端部署完成後，自動把 URL 寫入前端 `frontend-vue/.env.production` 與 `.env`**（`VITE_API_BASE_URL`）。

## 先決條件
- 安裝 **Terraform 1.8+**
- 安裝 **Google Cloud SDK**
- 已把映像推到 **Artifact Registry**
- 專案已綁 **Billing**

## 安裝Terraform和Google Cloud SDK
```bash
sudo rm -rf /Library/Developer/CommandLineTools
sudo xcode-select --install
brew tap hashicorp/tap
brew install hashicorp/tap/terraform
brew install --cask google-cloud-sdk
gcloud init
```

## 登入
```bash
gcloud auth login
gcloud auth application-default login
gcloud config set project htwg-cloudapp-hw
```

## 使用方式
```bash
# 1) 在這個資料夾
terraform init

# 2) 先看變數
cp terraform.tfvars.example terraform.tfvars
# 編輯 terraform.tfvars，把 backend_env / frontend_env 改成你 Readme.md 的值
# 並設定 backend_image / frontend_image 指向你在 Artifact Registry 的 image URL
# 範例：us-central1-docker.pkg.dev/your-project/your-repo/backend:latest

# 3) 套用
terraform apply
```

## 自動寫入 `VITE_API_BASE_URL`
本專案已內建最簡單實作：Terraform 會在 **後端 Cloud Run** 成功部署後，
自動把 `backend` 服務的 URL 寫入 `../frontend-vue/.env.production` 與 `.env`：
```dotenv
VITE_API_BASE_URL=https://<your-backend-xxxxx-uc.a.run.app>
```
> 如果你的前端資料夾不是 `../frontend-vue`，請在 `terraform/env-writer.tf` 中修改 `FRONTEND_DIR`。

## 會做什麼
- 啟用必要 API（Run / Artifact Registry / Firestore / STS / Firebase Storage / Identity Toolkit / Monitoring / Storage / SQL Admin）
- 建立 **Cloud SQL (MySQL 8.0)**：`db-f1-micro`（Shared Core）、HDD 10GB、無備份、Public IPv4、白名單 `0.0.0.0/0`（可自行縮限）
- **不建立/不修改** 任何使用者或密碼（即 **不會動 root 密碼**）
- 建立 2 個 Cloud Run：
  - Backend：CPU 1 / 1Gi、min=0 / max=5、掛載 `/cloudsql` 連 DB、環境變數從 `backend_env`
  - Frontend：CPU 1 / 1Gi、min=0 / max=5、環境變數從 `frontend_env`
- 兩個服務都先設為 **公開**（`roles/run.invoker` on `allUsers`）。想收斂可以移除 IAM 這兩段。

## 變更重點
- 若你想改成 `db-g1-small`，在 `terraform/variables.tf` 或 `terraform.tfvars` 把 `db_tier` 換成 `"db-g1-small"`。
- 想要更安全：
  - 把 `authorized_networks` 改成你的固定 IP；或
  - 改用私網 + Serverless VPC Access + Cloud SQL 連線器（可再提供對應 Terraform 版）。

## 輸出
- `backend_url` / `frontend_url`
- `cloud_sql_connection_name`
