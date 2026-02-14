#!/bin/bash

# Custom create_env.sh für Skillbox-Mixpost Integration
# Überschreibt /var/www/startup/create_env.sh im Container
# Fügt Skillbox-spezifische Env-Variablen hinzu

envFilePath="/var/www/html/.env"

cat <<EOL > $envFilePath
# This value is the name of your application.
APP_NAME="${APP_NAME:-Mixpost}"

# Key used to encrypt and decrypt sensitive data.
APP_KEY=${APP_KEY}

# Debug mode setting. Set to 'false' for production environments.
APP_DEBUG=${APP_DEBUG:-false}

# Full application URL.
APP_URL=${APP_URL:-http://localhost}

# MySQL connection setup
DB_HOST=${DB_HOST:-mysql}
DB_PORT=${DB_PORT:-3306}
DB_DATABASE=${DB_DATABASE}
DB_USERNAME=${DB_USERNAME}
DB_PASSWORD=${DB_PASSWORD}

# Redis connection setup
REDIS_HOST=${REDIS_HOST:-redis}
REDIS_PASSWORD=${REDIS_PASSWORD:-null}
REDIS_PORT=${REDIS_PORT:-6379}
REDIS_PREFIX=${REDIS_PREFIX:-mixpost_database_}

# Define log channel
MIXPOST_LOG_CHANNEL=${MIXPOST_LOG_CHANNEL:-mixpost}

# The disk on which to store added files.
MIXPOST_DISK=${MIXPOST_DISK:-public}

# Define cache prefix.
MIXPOST_CACHE_PREFIX=${MIXPOST_CACHE_PREFIX:-mixpost}

# SMTP
MAIL_MAILER=${MAIL_MAILER:-smtp}
MAIL_HOST=${MAIL_HOST:-smtp.mailgun.org}
MAIL_PORT=${MAIL_PORT:-587}
MAIL_USERNAME=${MAIL_USERNAME}
MAIL_PASSWORD=${MAIL_PASSWORD}
MAIL_ENCRYPTION=${MAIL_ENCRYPTION:-tls}
MAIL_FROM_ADDRESS="${MAIL_FROM_ADDRESS:-hello@example.com}"
MAIL_FROM_NAME="${MAIL_FROM_NAME:-Example}"

# AWS Credentials
AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}
AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}
AWS_DEFAULT_REGION=${AWS_DEFAULT_REGION}
AWS_BUCKET=${AWS_BUCKET}

# Laravel configs
QUEUE_CONNECTION=${QUEUE_CONNECTION:-redis}
CACHE_PREFIX=${CACHE_PREFIX:-mixpost_cache_}
SESSION_COOKIE=${SESSION_COOKIE:-mixpost_session}

# Additional settings
HORIZON_PREFIX=${HORIZON_PREFIX:-mixpost_horizon:}

# =============================================
# Skillbox Integration
# =============================================
# Server-to-Server (Docker container → Skillbox backend)
SKILLBOX_API_URL=${SKILLBOX_API_URL}
# Browser-side (User's browser → Skillbox backend)
SKILLBOX_BROWSER_URL=${SKILLBOX_BROWSER_URL}
SKILLBOX_TENANT=${SKILLBOX_TENANT:-default}
EOL

echo ".env file created successfully (with Skillbox integration)."
