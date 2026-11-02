# Export runtime environment variables
cp .env.example .env

# Launch via Docker Compose
docker compose up -d --build

# Verify container health and streaming logs
docker compose logs -f