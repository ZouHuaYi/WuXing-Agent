# Repository Guidelines

## Project Structure & Module Organization
- `src/engine/`: core agent runtime (orchestration, graph flow, skills, memory, event bus).
- `src/plugins/`: extension points (for example, `src/plugins/evolution/`).
- `src/utils/`: shared helpers such as logging and schema validation.
- `config/`: runtime JSON config (`wuxing.json`, `agents.json`, `mcp.json`).
- `skills/<skill-name>/`: skill packages with `SKILL.md`, `schema.json`, and `scripts/index.js`.
- `web/`: React + Vite frontend (`web/src/components`, `web/src/hooks`, `web/src/lib`).
- Root entrypoints: `main.js` (agent runtime), `server.js` (web gateway + SSE).

## Build, Test, and Development Commands
- `npm run start`: run the core agent from `main.js`.
- `npm run web`: start API/SSE server on `WEB_PORT` (default `3000`).
- `npm run web:dev`: run server + Vite dev UI together (`web/` on `3001` via proxy setup).
- `cd web && npm run dev`: frontend-only local development.
- `cd web && npm run build`: production build for frontend (`web/dist`).
- `cd web && npm run preview`: preview built frontend assets.

## Coding Style & Naming Conventions
- Use ESM (`"type": "module"`), `import`/`export`, and explicit `.js`/`.jsx` extensions.
- Indentation: 2 spaces in frontend React files; 4 spaces is common in backend engine modules. Match the surrounding file instead of reformatting unrelated code.
- Naming: camelCase for variables/functions, PascalCase for React components, kebab-case for skill folder names.
- Keep modules focused; place cross-cutting utilities in `src/utils/`.

## Testing Guidelines
- No automated test suite is currently configured (`npm test` is a placeholder and fails by design).
- For backend changes, validate by running `npm run start` and `npm run web`, then exercise `/api/chat` and `/api/stream`.
- For frontend changes, verify `cd web && npm run build` succeeds and smoke-test key screens in dev mode.
- If adding tests, place them near the feature (for example `src/engine/__tests__/...`) and document the run command in `package.json`.

## Commit & Pull Request Guidelines
- Follow existing Conventional Commit style in history: `feat: ...`, `fix: ...`.
- Keep each commit scoped to one logical change (runtime, web, or skill pack).
- PRs should include a concise summary and motivation.
- PRs should list impacted paths (example: `src/engine/orchestrator.js`, `web/src/App.jsx`).
- PRs should include verification steps/commands run.
- PRs should attach screenshots or short clips for UI changes.

## Security & Configuration Tips
- Never commit secrets; keep `.env` local and sync examples via `.env.example`.
- Treat `data/`, `logs/`, and `workspace/` as runtime artifacts (already git-ignored).
- Review skill scripts before enabling them, especially commands that execute shell or external API actions.
