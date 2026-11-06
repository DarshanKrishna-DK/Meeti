import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
export default defineConfig([...nextVitals, ...nextTypescript, globalIgnores([".next*/**", ".local-data/**", ".agents/**", ".codex/**", ".superdesign/**", "node_modules/**", "artifacts/**", "test-results/**", "playwright-report/**", "scripts/artwork/vendor/**", "next-env.d.ts"])]);
