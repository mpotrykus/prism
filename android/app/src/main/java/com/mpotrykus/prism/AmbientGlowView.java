package com.mpotrykus.prism;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ComposeShader;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.Shader;
import android.util.Log;
import android.view.View;

/* Android counterpart to ambient-pipeline.js's four glow <div>s (web/Xbox leg) - a
   solid black backdrop plus four edge LinearGradients (top/bottom/left/right, each
   fading from AmbientLightSampler's sampled edge color to transparent over whatever
   letterbox/pillarbox gap the video's own aspect ratio leaves) in place of CSS
   gradients + filter:blur(). Mounted as root's first child, behind playerView (see
   PlayerActivity.onCreate) - only visible at all once playerView's own (normally
   opaque black, see its construction in onCreate) background goes transparent while
   ambient lighting is on, revealing this behind PlayerView's own
   AspectRatioFrameLayout letterbox gap. Deliberately doesn't resize or zoom playerView
   itself - see PlayerActivity.layoutGlow's own comment for why. */
final class AmbientGlowView extends View {
    /* Fixed reach (not scaled to the actual letterbox/pillarbox gap size), matching
       ambient-pipeline.js's AMBIENT_GLOW_REACH_PX on the web leg - see onDraw for how
       this gets used as the fade gradient's own endpoint instead of the true screen
       edge, so the glow's falloff distance stays constant regardless of how large or
       small a given video's gap happens to be. DP rather than a flat px literal (unlike
       the web leg's CSS px) since, unlike blur radius, a "how far does the light travel"
       distance should look the same physical size across this app's actual density
       range (phone/tablet/TV), not just whatever the web leg's own viewport happens to
       be. */
    private static final float GLOW_REACH_DP = 240f;
    /* Sampled points along a cosine ease (0.5*(1+cos(pi*t))) rather than a flat-hold-
       then-linear-drop - continuously eases from full opacity to fully transparent with
       no kink where two different slopes met, which read as an unnaturally sudden
       cutoff. Matches ambient-pipeline.js's AMBIENT_FALLOFF_STEPS on the web leg. */
    private static final int FALLOFF_STEPS = 8;

    private static final int[] NO_ZONES = new int[0];

    private final Paint bgPaint = new Paint();
    private final Paint gradientPaint = new Paint();
    private final float glowReachPx;
    /* Mirrors ambient-pipeline.js's per-wrapper CSS `opacity` on the web leg - a
       compositing-level scalar applied only to gradientPaint (the glow color layer, via
       Paint.setAlpha in onDraw below), not to bgPaint's own permanently-opaque black
       fill. Set via PlayerActivity.setAmbientOpacity, not here directly - this field's
       default only matters before that's ever called. */
    private int glowAlpha = 128;
    /* One color per zone along the edge's own length (see AmbientLightSampler's
       ZONES_PER_EDGE) rather than one flat color for the whole side - blended smoothly
       between adjacent zones via alongEdgeGradient's gradient stops (see onDraw) rather
       than drawn as separate hard-edged rects, mimicking ambient-pipeline.js's
       filter:blur(36px) wrapper on the web leg without an actual blur pass. */
    private int[] topColors = NO_ZONES;
    private int[] bottomColors = NO_ZONES;
    private int[] leftColors = NO_ZONES;
    private int[] rightColors = NO_ZONES;
    /* Screen-space bounds of the actual rendered picture, set from
       PlayerActivity.layoutGlow (mirrors ambient-pipeline.js's computePictureRect) -
       accounts for the video's own aspect-ratio letterboxing/pillarboxing against the
       full screen. -1 means "not laid out yet", falling back to assuming no
       letterboxing (the full view is the picture) until the first real measurement
       arrives. */
    private float pictureLeft = -1f;
    private float pictureTop = -1f;
    private float pictureRight = -1f;
    private float pictureBottom = -1f;
    private boolean loggedFirstDraw = false;

    AmbientGlowView(Context context) {
        super(context);
        bgPaint.setColor(Color.BLACK);
        setWillNotDraw(false);
        glowReachPx = GLOW_REACH_DP * context.getResources().getDisplayMetrics().density;
    }

    /* Called from AmbientLightSampler's listener (already posted to the main thread,
       see AmbientLightSampler's own Handler) at roughly its own sample cadence - no
       throttling needed here beyond that. */
    void setColors(int[] top, int[] bottom, int[] left, int[] right) {
        this.topColors = top;
        this.bottomColors = bottom;
        this.leftColors = left;
        this.rightColors = right;
        invalidate();
    }

    /* left/top/right/bottom are the picture's own edges, not a fixed fraction of this
       view's bounds - content whose aspect ratio doesn't match the screen already
       letterboxes/pillarboxes itself (PlayerView's own AspectRatioFrameLayout), and
       this is exactly the gap ambient lighting fills - see PlayerActivity.layoutGlow
       for how these are computed. */
    void setPictureRect(float left, float top, float right, float bottom) {
        this.pictureLeft = left;
        this.pictureTop = top;
        this.pictureRight = right;
        this.pictureBottom = bottom;
        invalidate();
    }

    void setGlowOpacity(float opacity) {
        this.glowAlpha = Math.round(opacity * 255f);
        invalidate();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        int w = getWidth();
        int h = getHeight();
        if (!loggedFirstDraw) {
            loggedFirstDraw = true;
            Log.d("AmbientLighting", "AmbientGlowView.onDraw - w=" + w + " h=" + h
                + " pictureRect=[" + pictureLeft + "," + pictureTop + "," + pictureRight + "," + pictureBottom + "]"
                + " topColors=" + topColors.length + " leftColors=" + leftColors.length
                + " elevation=" + getElevation() + " alpha=" + getAlpha() + " visibility=" + getVisibility());
        }
        if (w == 0 || h == 0) return;
        canvas.drawRect(0, 0, w, h, bgPaint);
        /* Set once per onDraw, before any of the four edge draws below reuse this same
           Paint object - Paint's own alpha persists across drawRect calls until changed
           again, so one assignment here applies uniformly to all four. */
        gradientPaint.setAlpha(glowAlpha);

        float left = pictureLeft >= 0 ? pictureLeft : 0f;
        float top = pictureTop >= 0 ? pictureTop : 0f;
        float right = pictureRight >= 0 ? pictureRight : w;
        float bottom = pictureBottom >= 0 ? pictureBottom : h;

        /* Color at the picture's own edge, fading out over glowReachPx - not necessarily
           all the way to this view's true edge (see GLOW_REACH_DP's own comment). A gap
           narrower than the reach only shows this curve's early, still-bright portion;
           a gap wider than the reach lets the glow fully fade out before reaching the
           true edge, leaving plain black beyond it - both intentional. */
        drawHorizontalEdge(canvas, 0, 0, w, top, top, top - glowReachPx, topColors);
        drawHorizontalEdge(canvas, 0, bottom, w, h, bottom, bottom + glowReachPx, bottomColors);
        drawVerticalEdge(canvas, 0, 0, left, h, left, left - glowReachPx, leftColors);
        drawVerticalEdge(canvas, right, 0, w, h, right, right + glowReachPx, rightColors);
    }

    /* One draw call for the whole edge (used for top/bottom) instead of one rect per
       zone: alongEdgeGradient blends the zone colors smoothly across the rect's own
       width, and a second, perpendicular falloffMask (full opacity at fadeFromY - the
       picture's own edge - continuously easing to fully transparent at fadeToY, a fixed
       distance away rather than necessarily this view's true edge - see GLOW_REACH_DP)
       supplies the alpha. ComposeShader's SRC_IN keeps the color gradient's own color,
       masked by the fade gradient's alpha - the same "vary color along the edge, fade
       perpendicular to it" split ambient-pipeline.js's flex-of-gradients achieves on the
       web leg via layout instead of shader math. ComposeShader's own javadoc names its
       first argument shaderA as the mode's "dst" and its second argument shaderB as the
       mode's "src" - backwards from what the parameter order visually suggests - so
       fadeMask (whose alpha we want to keep) has to be passed first and colorShader
       (whose color we want to keep) second, or SRC_IN instead keeps the mask's own flat
       white. */
    private void drawHorizontalEdge(Canvas canvas, float rectLeft, float rectTop, float rectRight, float rectBottom,
        float fadeFromY, float fadeToY, int[] colors) {
        if (rectRight <= rectLeft || rectBottom <= rectTop || colors.length == 0) return;
        Shader colorShader = alongEdgeGradient(rectLeft, 0, rectRight, 0, colors);
        Shader fadeMask = falloffMask(0, fadeFromY, 0, fadeToY);
        gradientPaint.setShader(new ComposeShader(fadeMask, colorShader, PorterDuff.Mode.SRC_IN));
        canvas.drawRect(rectLeft, rectTop, rectRight, rectBottom, gradientPaint);
    }

    /* Same as drawHorizontalEdge but the color blend runs along the rect's own height
       and the fade runs horizontally (used for left/right). */
    private void drawVerticalEdge(Canvas canvas, float rectLeft, float rectTop, float rectRight, float rectBottom,
        float fadeFromX, float fadeToX, int[] colors) {
        if (rectRight <= rectLeft || rectBottom <= rectTop || colors.length == 0) return;
        Shader colorShader = alongEdgeGradient(0, rectTop, 0, rectBottom, colors);
        Shader fadeMask = falloffMask(fadeFromX, 0, fadeToX, 0);
        gradientPaint.setShader(new ComposeShader(fadeMask, colorShader, PorterDuff.Mode.SRC_IN));
        canvas.drawRect(rectLeft, rectTop, rectRight, rectBottom, gradientPaint);
    }

    /* A plain white gradient whose alpha alone traces a cosine ease from fully opaque at
       (x0,y0) to fully transparent at (x1,y1) - only the alpha channel matters here,
       since ComposeShader's SRC_IN in the callers above discards this shader's own RGB
       entirely and keeps colorShader's instead. TileMode.CLAMP holds the last stop's
       (fully transparent) alpha for anything beyond (x1,y1), and the first stop's
       (fully opaque) alpha for anything before (x0,y0) - both matter here since (x1,y1)
       is deliberately not always the view's own true edge (see GLOW_REACH_DP). */
    private static Shader falloffMask(float x0, float y0, float x1, float y1) {
        int[] colors = new int[FALLOFF_STEPS];
        float[] positions = new float[FALLOFF_STEPS];
        for (int i = 0; i < FALLOFF_STEPS; i++) {
            float t = i / (float) (FALLOFF_STEPS - 1);
            int alpha = Math.round(0.5f * (1f + (float) Math.cos(Math.PI * t)) * 255f);
            colors[i] = Color.argb(alpha, 255, 255, 255);
            positions[i] = t;
        }
        return new LinearGradient(x0, y0, x1, y1, colors, positions, Shader.TileMode.CLAMP);
    }

    /* A stop at each zone's own center (not at its edges) so the color holds roughly
       constant near the middle of each zone and blends across the boundary with its
       neighbors, rather than jumping abruptly - LinearGradient extends the first/last
       stop's color outward automatically, so the outermost zones stay solid right up to
       this edge's own outer boundary. */
    private static Shader alongEdgeGradient(float x0, float y0, float x1, float y1, int[] colors) {
        int n = colors.length;
        if (n == 1) {
            return new LinearGradient(x0, y0, x1, y1, colors[0], colors[0], Shader.TileMode.CLAMP);
        }
        float[] positions = new float[n];
        for (int i = 0; i < n; i++) positions[i] = (i + 0.5f) / n;
        return new LinearGradient(x0, y0, x1, y1, colors, positions, Shader.TileMode.CLAMP);
    }
}
