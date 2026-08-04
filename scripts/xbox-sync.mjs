// Copies the built web app (dist/) into the Xbox UWP shell's www/ folder so it can be bundled
// into the appx package as Content. Run after `vite build` via `npm run xbox:sync`.
//
// Uses a plain Node script instead of robocopy/xcopy: robocopy's "success" exit codes are
// non-zero (0-7), which npm treats as a script failure unless specifically worked around, and
// xcopy only overlays files rather than removing ones that no longer exist in the new build.
import { existsSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const distDir = new URL("../dist/", import.meta.url);
const wwwDir = new URL("../xbox/PrismXbox/www/", import.meta.url);

if (!existsSync(distDir)) {
  console.error(`xbox-sync: dist/ not found under ${repoRoot} - did the vite build step run?`);
  process.exit(1);
}

rmSync(wwwDir, { recursive: true, force: true });
mkdirSync(wwwDir, { recursive: true });
cpSync(distDir, wwwDir, { recursive: true });

console.log("xbox-sync: copied dist/ -> xbox/PrismXbox/www/");
