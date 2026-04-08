## Frontend

Built with Bun, React 19, TypeScript, and Tailwind CSS v4.

- `bun run dev` — start Bun dev server with HMR (`bun --hot src/index.html`)
- `bun run build` — production build via `bun build.ts` → `dist/`
- Tailwind v4 integration via `bun-plugin-tailwind`
- Path alias: `@/*` → `./src/*` (read from tsconfig.json)
- Tailwind v4 with CSS-based config in `styles/globals.css`
