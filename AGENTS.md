# AGENTS.md

## Commands
- `npm start` - Run dev server with tsx watch (hot reload)
- No build/lint/test commands configured

## Code Style
- ESM project (`"type": "module"`) with Express 5.x
- Double quotes, no semicolons, 2-space indentation
- Use `type` keyword for type-only imports: `import { type Request } from "express"`
- `camelCase` for variables/functions, prefix unused params with underscore: `_req`
- Interfaces for API response types, Zod for runtime validation schemas

## TypeScript
- Strict mode with `noUncheckedIndexedAccess` - always check for undefined on indexed access
- `verbatimModuleSyntax: true` - use explicit `type` keyword for type imports
- Use `as Type` assertion for fetch JSON responses

## Error Handling
- Throw `new Error()` with descriptive messages for invalid states
- Check optional chaining results before destructuring: `if (!data.results?.[0]) throw`

## Project Structure
- `src/` - Source code, `src/mastra/` - Mastra AI agents, tools, workflows
