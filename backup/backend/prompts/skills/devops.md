---
name: devops
description: Docker, Kubernetes, CI/CD pipelines, Terraform and deployment configuration. Use when the task touches containers, pipelines, infrastructure, or shipping to an environment.
---

## DevOps Expert Context

You are working on Docker, CI/CD, cloud deployments, or infrastructure configuration.

### Dockerfile Best Practices
```dockerfile
# Multi-stage build — keeps the final image small
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production       # install deps first (layer cached if package.json unchanged)
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
RUN addgroup -S appgroup && adduser -S appuser -G appgroup  # non-root user
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
USER appuser
EXPOSE 3000
CMD ["node", "dist/server.js"]
```
- `.dockerignore`: always exclude `node_modules`, `.git`, `.env`, `*.log`, `dist`
- Use specific tags, not `latest`: `node:20.11-alpine` not `node:latest`
- One process per container — use a process manager (supervisord) only when absolutely needed
- `HEALTHCHECK` instruction tells orchestrators when a container is ready

### Docker Compose
```yaml
services:
  api:
    build: .
    ports: ["3000:3000"]
    environment:
      DATABASE_URL: postgres://user:pass@db:5432/mydb
    depends_on:
      db:
        condition: service_healthy   # wait for DB to be ready, not just started
    restart: unless-stopped

  db:
    image: postgres:16-alpine
    volumes:
      - pgdata:/var/lib/postgresql/data  # named volume for persistence
    environment:
      POSTGRES_PASSWORD: pass
      POSTGRES_USER: user
      POSTGRES_DB: mydb
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U user -d mydb"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  pgdata:
```

### GitHub Actions CI/CD
```yaml
name: CI/CD
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npm test

  deploy:
    needs: test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build and push Docker image
        uses: docker/build-push-action@v5
        with:
          push: true
          tags: registry.example.com/app:${{ github.sha }}
```
- Store secrets in GitHub Secrets, never in the workflow file
- Use `actions/cache` for `node_modules`, pip, Maven — speeds up CI dramatically
- Pin action versions with a full SHA for security: `actions/checkout@abc1234`

### Environment & Secrets
```bash
# Never commit .env — use .env.example as the template
DATABASE_URL=               # required
API_KEY=                    # required
LOG_LEVEL=info              # optional, defaults to info
```
- Dev: `.env` file loaded by dotenv
- Staging/prod: inject via orchestrator (Kubernetes secrets, AWS Secrets Manager, Vault)
- Rotate secrets on a schedule and after any potential exposure

### Nginx Configuration
```nginx
server {
    listen 80;
    server_name example.com;
    return 301 https://$host$request_uri;  # redirect HTTP → HTTPS
}

server {
    listen 443 ssl;
    server_name example.com;

    location /api/ {
        proxy_pass http://api:3000/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300s;          # for long-running requests
    }

    location / {
        root /var/www/html;
        try_files $uri /index.html;       # SPA routing
    }
}
```

### Tool Guidance
```bash
docker build -t myapp:latest .
docker compose up -d
docker compose logs -f api
docker exec -it container_name sh

# Check running containers
docker ps
docker stats

# Kubernetes
kubectl apply -f k8s/
kubectl rollout status deployment/api
kubectl logs -f deployment/api
```

### Pitfalls
- Running containers as root — always add a non-root user
- Baking secrets into the image — use build args for non-secret config, runtime env for secrets
- `npm install` in Dockerfile instead of `npm ci` — `ci` is deterministic and faster
- No health checks — orchestrators can't detect crashed apps without them
- Deploying directly to production without staging — always test in a staging environment first
