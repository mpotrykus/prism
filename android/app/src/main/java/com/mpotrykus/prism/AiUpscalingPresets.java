package com.mpotrykus.prism;

import android.content.res.AssetManager;
import android.util.Log;
import java.util.ArrayList;
import java.util.List;

/* Android port of shaders.js's anime4k_cnn/live_action_fsr registration - the real Anime4K v4
   CNN chain and AMD FSR 1 (EASU+RCAS), loaded verbatim from the vendored mpv-user-shader files
   in assets/shaders/vendor/ via MpvUserShader, run through GlPassChain. Composition mirrors the
   web leg exactly (see shaders.js's buildAnime4kCnn/buildFsr for the authoritative comments on
   *why* each ordering choice was made - deband baked in unconditionally, sharpening stacked as
   an always-present trailing pass rather than one toggle superseding the other):

     anime4k_cnn: [Restore-CNN passes...] -> [Upscale-CNN passes...] -> deband -> present -> sharpen(anime)
     live_action_fsr: luma-extract -> EASU -> deband -> RCAS -> luma-merge -> sharpen(cas)

   Built lazily, once per process, behind a try/catch per preset - same reasoning as the web
   leg's try/catch around SHADER_TYPES.anime4k_cnn/live_action_fsr: a device whose GL context
   can't build one of these (or the asset didn't sync) should quietly fall back to the existing
   single-pass Sharpening effect rather than losing AI Upscaling entirely. */
final class AiUpscalingPresets {

    private static final String TAG = "PrismAiUpscale";
    private static final String LUMA_EXTRACT_PASS = "luma-extract";

    static final class Preset {
        final String key;
        final List<GlPassChain.PassSpec> passes;
        final MpvUserShader.WhenGate when; // nullable - null means "always applies once a candidate"
        final float scale; // fixed output/source ratio both these presets declare

        Preset(String key, List<GlPassChain.PassSpec> passes, MpvUserShader.WhenGate when, float scale) {
            this.key = key;
            this.passes = passes;
            this.when = when;
            this.scale = scale;
        }
    }

    private static boolean built = false;
    private static Preset animeCnn;
    private static Preset liveActionFsr;

    private AiUpscalingPresets() {}

    private static synchronized void ensureBuilt(AssetManager assets) {
        if (built) return;
        built = true;
        try {
            animeCnn = buildAnimeCnn(assets);
        } catch (RuntimeException e) {
            Log.e(TAG, "Anime4K CNN preset unavailable - " + e.getMessage());
        }
        try {
            liveActionFsr = buildLiveActionFsr(assets);
        } catch (RuntimeException e) {
            Log.e(TAG, "FSR 1 preset unavailable - " + e.getMessage());
        }
    }

    /** Null if this family has no AI Upscaling upgrade, or it failed to build on this device. */
    static Preset forFamily(AssetManager assets, ShaderType family) {
        ensureBuilt(assets);
        if (family == ShaderType.ANIME4K) return animeCnn;
        if (family == ShaderType.LIVE_ACTION) return liveActionFsr;
        return null;
    }

    private static GlPassChain.PassSpec debandPass(AssetManager assets, String name, String fromName) {
        String frag = GlAssetLoader.read(assets, "deband.frag.glsl");
        return new GlPassChain.PassSpec(
            name, frag,
            List.of(new GlPassChain.PassSpec.Input("uTex", fromName)),
            (ctx) -> ctx.sizeOf(fromName),
            1f, /* floatRequired= */ true);
    }

    private static Preset buildAnimeCnn(AssetManager assets) {
        String restoreSrc = GlAssetLoader.read(assets, "vendor/anime4k-restore-cnn-s.glsl");
        String upscaleSrc = GlAssetLoader.read(assets, "vendor/anime4k-upscale-cnn-x2-s.glsl");
        String presentFrag = GlAssetLoader.read(assets, "present.frag.glsl");
        String sharpenAnimeFrag = GlAssetLoader.read(assets, "sharpen-anime.frag.glsl");

        List<MpvUserShader.NamedSource> sources = new ArrayList<>();
        sources.add(new MpvUserShader.NamedSource(restoreSrc, "a4k-restore"));
        sources.add(new MpvUserShader.NamedSource(upscaleSrc, "a4k-upscale"));
        MpvUserShader.LoadResult loaded = MpvUserShader.loadChain(sources, GlPassChain.SOURCE);

        String lastCnnPassName = loaded.passes.get(loaded.passes.size() - 1).name;

        List<GlPassChain.PassSpec> passes = new ArrayList<>(loaded.passes);
        passes.add(debandPass(assets, "deband", lastCnnPassName));
        passes.add(new GlPassChain.PassSpec(
            "present", presentFrag,
            List.of(new GlPassChain.PassSpec.Input("uTex", "deband")),
            (ctx) -> new int[] {ctx.outW(), ctx.outH()},
            1f, /* floatRequired= */ false));
        // Sharpening's own algorithm always stacks on top - explicit user call, see shaders.js.
        passes.add(new GlPassChain.PassSpec(
            "sharpen", sharpenAnimeFrag,
            List.of(new GlPassChain.PassSpec.Input("uTex", "present")),
            1f, /* floatRequired= */ false));

        return new Preset("anime4k_cnn", passes, loaded.when, 2f);
    }

    private static Preset buildLiveActionFsr(AssetManager assets) {
        String fsrSrc = GlAssetLoader.read(assets, "vendor/fsr1-easu-rcas.glsl");
        String lumaExtractFrag = GlAssetLoader.read(assets, "luma-extract.frag.glsl");
        String lumaMergeFrag = GlAssetLoader.read(assets, "luma-merge.frag.glsl");
        String sharpenCasFrag = GlAssetLoader.read(assets, "sharpen-cas.frag.glsl");

        MpvUserShader.LoadResult loaded = MpvUserShader.load(fsrSrc, "fsr1", LUMA_EXTRACT_PASS);
        GlPassChain.PassSpec easu = loaded.passes.get(0);
        GlPassChain.PassSpec rcas = loaded.passes.get(1);
        GlPassChain.PassSpec deband = debandPass(assets, "fsr-deband", easu.name);

        List<GlPassChain.PassSpec.Input> rcasInputs = new ArrayList<>();
        for (GlPassChain.PassSpec.Input input : rcas.inputs) {
            rcasInputs.add(input.from.equals(easu.name) ? new GlPassChain.PassSpec.Input(input.uniform, deband.name) : input);
        }
        GlPassChain.PassSpec rcasAfterDeband = new GlPassChain.PassSpec(rcas.name, rcas.frag, rcasInputs, rcas.size, rcas.scale, rcas.floatRequired);

        List<GlPassChain.PassSpec> passes = new ArrayList<>();
        passes.add(new GlPassChain.PassSpec(
            LUMA_EXTRACT_PASS, lumaExtractFrag,
            List.of(new GlPassChain.PassSpec.Input("uTex", GlPassChain.SOURCE)),
            1f, /* floatRequired= */ true));
        passes.add(easu);
        passes.add(deband);
        passes.add(rcasAfterDeband);
        passes.add(new GlPassChain.PassSpec(
            "luma-merge", lumaMergeFrag,
            List.of(
                new GlPassChain.PassSpec.Input("uSource", GlPassChain.SOURCE),
                new GlPassChain.PassSpec.Input("uLuma", rcasAfterDeband.name)),
            (ctx) -> new int[] {ctx.outW(), ctx.outH()},
            1f, /* floatRequired= */ false));
        // Sharpening's own algorithm always stacks on top - explicit user call, see shaders.js.
        passes.add(new GlPassChain.PassSpec(
            "sharpen", sharpenCasFrag,
            List.of(new GlPassChain.PassSpec.Input("uTex", "luma-merge")),
            1f, /* floatRequired= */ false));

        return new Preset("live_action_fsr", passes, loaded.when, 2f);
    }
}
