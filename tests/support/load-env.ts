import { existsSync } from 'node:fs';

// Integration tests read the same .env as docker compose (cp .env.example .env).
if (existsSync('.env')) process.loadEnvFile('.env');
