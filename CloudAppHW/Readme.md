
Content in ./CloudAppHW/backend-api/.env
<pre>
# GCP Setting
GCP_SERVICE_ACCOUNT_JSON={  "type": "service_account",  "project_id": "htwg-cloudapp-hw",  "private_key_id": "xxxxxxxxxxx",  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIxxxxxxxLII\n-----END PRIVATE KEY-----\n",  "client_email": "xxx",  "client_id": "xxx",  "auth_uri": "https://accounts.google.com/o/oauth2/auth",  "token_uri": "xxx",  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",  "client_x509_cert_url": "xxx",  "universe_domain": "googleapis.com"}

GEMINI_API_KEY=xxxx
GCP_BUCKET_NAME=htwg-cloudapp-hw.firebasestorage.app


# DB Setting
DB_HOST=localhost           #DB URL
DB_USER=cloudapp_user       # usename
DB_PASSWORD=mypassword      # password
DB_NAME=travel_app_db

# Server Setting
PORT=3000
</pre>

Content in ./CloudAppHW/frontend-vue/.env
<pre>
VITE_API_BASE_URL=http://192.168.183.140:3000                      #backend url

VITE_FIREBASE_API_KEY=AIxxxxxc                                     #firebase api key
VITE_FIREBASE_AUTH_DOMAIN=htwg-cloudapp-hw.firebaseapp.com         #firebase auth domain
VITE_FIREBASE_PROJECT_ID=htwg-cloudapp-hw                          #firebase project id    
VITE_FIREBASE_APP_ID=xxxxx                                         #firebase app id
VITE_FIREBASE_STORAGE_BUCKET=htwg-cloudapp-hw.firebasestorage.app  #firebase storage bucket
VITE_MEASUREMENTID=G-Z5BGREZS4R                                    #measurement id
</pre>
