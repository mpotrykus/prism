package com.mpotrykus.prism;

import android.content.res.AssetManager;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/* Reads GLSL text assets from assets/shaders/ (synced verbatim from src/player/shader/glsl/ by
   scripts/android-sync-shaders.mjs - see that script's header for why this exists instead of the
   old hand-maintained Java string constants). Cached process-wide since the same file is read
   once per app-lifetime GL context, not once per playback session. */
final class GlAssetLoader {

    private static final Map<String, String> cache = new HashMap<>();

    private GlAssetLoader() {}

    static synchronized String read(AssetManager assets, String relativePath) {
        String cached = cache.get(relativePath);
        if (cached != null) return cached;
        String path = "shaders/" + relativePath;
        try (InputStream in = assets.open(path)) {
            StringBuilder sb = new StringBuilder();
            BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line).append('\n');
            }
            String contents = sb.toString();
            cache.put(relativePath, contents);
            return contents;
        } catch (IOException e) {
            throw new RuntimeException("GlAssetLoader: could not read asset \"" + path + "\"", e);
        }
    }
}
