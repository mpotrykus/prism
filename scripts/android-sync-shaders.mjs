// Copies src/player/shader/glsl/**/*.glsl (including vendor/, the verbatim upstream Anime4K
// CNN / FSR1 files) into android/app/src/main/assets/shaders/, so Android's AI Upscaling GL
// pipeline loads the exact same shader source the web leg does via AssetManager, instead of a
// third hand-maintained copy as Java string constants. Run before every Android build - see
// npm run android / android:deploy.
import { existsSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const srcDir = new URL("../src/player/shader/glsl/", import.meta.url);
const destDir = new URL("../android/app/src/main/assets/shaders/", import.meta.url);

if (!existsSync(srcDir)) {
  console.error(`android-sync-shaders: source dir not found under ${repoRoot}`);
  process.exit(1);
}

rmSync(destDir, { recursive: true, force: true });
mkdirSync(destDir, { recursive: true });
cpSync(srcDir, destDir, { recursive: true });

console.log("android-sync-shaders: copied src/player/shader/glsl/ -> android/app/src/main/assets/shaders/");
