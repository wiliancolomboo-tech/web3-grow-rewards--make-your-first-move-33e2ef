docker compose ps
docker compose logs --tail=100 worker
curl -fsS http://localhost:8080/healthz
curl -fsS http://localhost:8080/readyz