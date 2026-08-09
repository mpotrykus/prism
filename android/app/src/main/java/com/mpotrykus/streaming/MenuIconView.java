package com.mpotrykus.streaming;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.RectF;
import android.view.View;

/* One icon per row of the More sheet - mirrors src/player/ui/shared.js's own set of
   *IconMarkup functions (chaptersIconMarkup, subtitlesIconMarkup, etc.) shape-for-shape,
   so the two platforms read as one icon family instead of two unrelated glyph sets.
   A single enum-driven class rather than one class per icon (the convention
   EpisodeListIconView/SeekIconView/etc. otherwise follow) - those each back a distinct,
   independently-reusable button; these ~17 only ever appear in this one context (a
   menu row's own icon slot), so one class with a drawing method per case is the better
   fit here, not a deviation for its own sake. Every draw method below works in the same
   24x24 logical box as the web SVGs (see the shared 0.75-scale/center transform in
   onDraw, identical to EpisodeListIconView's own scaling), so geometry ports over
   directly without unit conversion. */
class MenuIconView extends View {

    enum Icon {
        CHAPTERS, AUDIO_TRACK, SUBTITLES, VERSION, QUALITY_CAP, AUTO_PLAY, EFFECTS, EXTRAS,
        PERFORMANCE, SHADER, COLOR_BOOST, AMBIENT, SPEED, ZOOM, SLEEP, LOCK, PICTURE_IN_PICTURE,
        EPISODES,
    }

    private final Icon icon;
    private final Paint fillPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint strokePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path path = new Path();
    private final RectF rect = new RectF();

    /* Menu-row icons dim slightly (same rgba(255,255,255,0.75) tint chrome.js's own
       icon wrapper uses, so the icon reads a touch lighter than the label next to it);
       standalone top-corner buttons (Lock/Picture-in-Picture, see
       PlayerUiHelper.buildLockButton/buildPipButton) use this same class at full white
       instead, matching every other corner icon button (EpisodeListIconView et al.). */
    MenuIconView(Context context, Icon icon) {
        this(context, icon, Color.argb(191, 255, 255, 255));
    }

    MenuIconView(Context context, Icon icon, int tint) {
        super(context);
        this.icon = icon;
        fillPaint.setColor(tint);
        fillPaint.setStyle(Paint.Style.FILL);
        strokePaint.setColor(tint);
        strokePaint.setStyle(Paint.Style.STROKE);
        strokePaint.setStrokeWidth(1.8f);
        strokePaint.setStrokeCap(Paint.Cap.ROUND);
        strokePaint.setStrokeJoin(Paint.Join.ROUND);
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float w = getWidth();
        float h = getHeight();
        float unit = Math.min(w, h);
        float boxSize = unit * 0.75f;
        float scale = boxSize / 24f;
        /* Every draw*() method below scales its own stroke width back up by 1/scale
           first - Paint.setStrokeWidth is in view pixels, not the 24x24 logical units
           the canvas transform below maps everything else into, so a fixed "1.8" would
           render far too thin/thick depending on the view's actual on-screen size. */
        strokePaint.setStrokeWidth(1.8f / scale);
        canvas.save();
        canvas.translate((w - boxSize) / 2f, (h - boxSize) / 2f);
        canvas.scale(scale, scale);

        switch (icon) {
            case CHAPTERS: drawChapters(canvas); break;
            case AUDIO_TRACK: drawAudioTrack(canvas); break;
            case SUBTITLES: drawSubtitles(canvas); break;
            case VERSION: drawVersion(canvas); break;
            case QUALITY_CAP: drawQualityCap(canvas); break;
            case AUTO_PLAY: drawAutoPlay(canvas); break;
            case EFFECTS: drawEffects(canvas); break;
            case EXTRAS: drawExtras(canvas); break;
            case PERFORMANCE: drawPerformance(canvas); break;
            case SHADER: drawShader(canvas); break;
            case COLOR_BOOST: drawColorBoost(canvas); break;
            case AMBIENT: drawAmbient(canvas); break;
            case SPEED: drawSpeed(canvas); break;
            case ZOOM: drawZoom(canvas); break;
            case SLEEP: drawSleep(canvas); break;
            case LOCK: drawLock(canvas); break;
            case PICTURE_IN_PICTURE: drawPictureInPicture(canvas); break;
            case EPISODES: drawEpisodes(canvas); break;
        }

        canvas.restore();
    }

    /* Mirrors chaptersIconMarkup's "M6 2h12v19l-6-4-6 4V2z" bookmark ribbon. */
    private void drawChapters(Canvas canvas) {
        path.reset();
        path.moveTo(6, 2);
        path.lineTo(18, 2);
        path.lineTo(18, 21);
        path.lineTo(12, 17);
        path.lineTo(6, 21);
        path.close();
        canvas.drawPath(path, fillPaint);
    }

    /* Simplified from volumeIconMarkup's high-volume state - the speaker triangle is an
       exact port; the two lens-shaped wave paths there are approximated here as two
       plain concentric arcs (equivalent "sound waves" reading, cheaper to get right in
       Canvas than porting the SVG's cubic-curve lens shapes stroke-for-stroke). */
    private void drawAudioTrack(Canvas canvas) {
        path.reset();
        path.moveTo(3, 9);
        path.lineTo(3, 15);
        path.lineTo(7, 15);
        path.lineTo(12, 20);
        path.lineTo(12, 4);
        path.lineTo(7, 9);
        path.close();
        canvas.drawPath(path, fillPaint);
        rect.set(13, 8, 19, 16);
        canvas.drawArc(rect, -50, 100, false, strokePaint);
        rect.set(13, 4, 23, 20);
        canvas.drawArc(rect, -50, 100, false, strokePaint);
    }

    /* Mirrors subtitlesIconMarkup's rounded-rect-plus-two-bars "CC" shape. */
    private void drawSubtitles(Canvas canvas) {
        rect.set(2, 5, 22, 19);
        canvas.drawRoundRect(rect, 2, 2, strokePaint);
        rect.set(5, 9, 15, 11);
        canvas.drawRoundRect(rect, 1, 1, fillPaint);
        rect.set(5, 13, 11, 15);
        canvas.drawRoundRect(rect, 1, 1, fillPaint);
    }

    /* Mirrors versionIconMarkup's classic three-layer "stack" glyph. */
    private void drawVersion(Canvas canvas) {
        path.reset();
        path.moveTo(12, 3);
        path.lineTo(21, 8);
        path.lineTo(12, 13);
        path.lineTo(3, 8);
        path.close();
        canvas.drawPath(path, strokePaint);
        path.reset();
        path.moveTo(3, 12);
        path.lineTo(12, 17);
        path.lineTo(21, 12);
        canvas.drawPath(path, strokePaint);
        path.reset();
        path.moveTo(3, 16);
        path.lineTo(12, 21);
        path.lineTo(21, 16);
        canvas.drawPath(path, strokePaint);
    }

    /* Mirrors qualityCapIconMarkup's ascending signal-bar glyph. */
    private void drawQualityCap(Canvas canvas) {
        canvas.drawRoundRect(3, 14, 7, 21, 1, 1, fillPaint);
        canvas.drawRoundRect(10, 9, 14, 21, 1, 1, fillPaint);
        canvas.drawRoundRect(17, 4, 21, 21, 1, 1, fillPaint);
    }

    /* Reuses ChapterSkipIconView's own single-triangle-plus-bar "next" shape (see that
       class) rather than a fourth near-identical shape - Auto-Play advancing to the
       next queued item is exactly the same idea as that skip-forward glyph. Drawn by
       hand here (not by delegating to ChapterSkipIconView) since this class already
       owns its own 24x24-space canvas transform that class doesn't share. */
    private void drawAutoPlay(Canvas canvas) {
        path.reset();
        path.moveTo(8, 5);
        path.lineTo(8, 19);
        path.lineTo(16.2f, 12);
        path.close();
        canvas.drawPath(path, fillPaint);
        canvas.drawRect(16.6f, 5, 18.8f, 19, fillPaint);
    }

    /* Mirrors effectsIconMarkup's 4-point sparkle. */
    private void drawEffects(Canvas canvas) {
        path.reset();
        path.moveTo(12, 2);
        path.lineTo(14.2f, 8.2f);
        path.lineTo(20, 10);
        path.lineTo(14.2f, 11.8f);
        path.lineTo(12, 18);
        path.lineTo(9.8f, 11.8f);
        path.lineTo(4, 10);
        path.lineTo(9.8f, 8.2f);
        path.close();
        canvas.drawPath(path, fillPaint);
    }

    /* Mirrors extrasIconMarkup's 3-line equalizer/sliders glyph. */
    private void drawExtras(Canvas canvas) {
        canvas.drawLine(4, 6, 20, 6, strokePaint);
        canvas.drawCircle(9, 6, 2.2f, fillPaint);
        canvas.drawLine(4, 12, 20, 12, strokePaint);
        canvas.drawCircle(15, 12, 2.2f, fillPaint);
        canvas.drawLine(4, 18, 20, 18, strokePaint);
        canvas.drawCircle(11, 18, 2.2f, fillPaint);
    }

    /* Mirrors performanceIconMarkup's activity/pulse zigzag. */
    private void drawPerformance(Canvas canvas) {
        path.reset();
        path.moveTo(2, 14);
        path.lineTo(7, 14);
        path.lineTo(10, 6);
        path.lineTo(14, 18);
        path.lineTo(17, 10);
        path.lineTo(22, 10);
        canvas.drawPath(path, strokePaint);
    }

    /* Reuses the same four-corner-bracket "expand" glyph fullscreenIconMarkup(false)
       draws on the web leg - upscaling is, visually, the same "stretch the picture
       outward" idea as entering fullscreen. */
    private void drawShader(Canvas canvas) {
        drawCornerBracket(canvas, 7, 7, -1, 0, 0, -1);
        drawCornerBracket(canvas, 17, 7, 1, 0, 0, -1);
        drawCornerBracket(canvas, 7, 17, -1, 0, 0, 1);
        drawCornerBracket(canvas, 17, 17, 1, 0, 0, 1);
    }

    /* One "L"-shaped corner mark: two short arms meeting at (x,y), each running in the
       direction (dx,dy) given for that arm - (dx1,dy1) for the first, (dx2,dy2) for the
       second. Shared by the four corners drawShader above draws. */
    private void drawCornerBracket(Canvas canvas, float x, float y, float dx1, float dy1, float dx2, float dy2) {
        float len = 4f;
        path.reset();
        path.moveTo(x + dx1 * len, y + dy1 * len);
        path.lineTo(x, y);
        path.lineTo(x + dx2 * len, y + dy2 * len);
        canvas.drawPath(path, strokePaint);
    }

    /* Mirrors colorBoostIconMarkup's half-filled "contrast" circle. */
    private void drawColorBoost(Canvas canvas) {
        rect.set(3, 3, 21, 21);
        canvas.drawOval(rect, strokePaint);
        canvas.drawArc(rect, -90, 180, true, fillPaint);
    }

    /* Mirrors ambientIconMarkup's sun-with-rays glyph. */
    private void drawAmbient(Canvas canvas) {
        canvas.drawCircle(12, 12, 4.5f, fillPaint);
        canvas.drawLine(12, 1, 12, 4, strokePaint);
        canvas.drawLine(12, 20, 12, 23, strokePaint);
        canvas.drawLine(1, 12, 4, 12, strokePaint);
        canvas.drawLine(20, 12, 23, 12, strokePaint);
        canvas.drawLine(4.2f, 4.2f, 6.3f, 6.3f, strokePaint);
        canvas.drawLine(17.7f, 17.7f, 19.8f, 19.8f, strokePaint);
        canvas.drawLine(4.2f, 19.8f, 6.3f, 17.7f, strokePaint);
        canvas.drawLine(17.7f, 6.3f, 19.8f, 4.2f, strokePaint);
    }

    /* Mirrors speedIconMarkup's gauge-with-needle glyph. */
    private void drawSpeed(Canvas canvas) {
        rect.set(4, 10, 20, 26);
        canvas.drawArc(rect, 180, 180, false, strokePaint);
        canvas.drawLine(12, 18, 16, 12, strokePaint);
        canvas.drawCircle(12, 18, 1.4f, fillPaint);
    }

    /* Mirrors zoomIconMarkup's magnifying-glass glyph. */
    private void drawZoom(Canvas canvas) {
        canvas.drawCircle(10.5f, 10.5f, 6.5f, strokePaint);
        canvas.drawLine(15.3f, 15.3f, 21, 21, strokePaint);
    }

    /* Mirrors sleepIconMarkup's crescent-moon glyph - unlike that single SVG path, a
       crescent needs an actual boolean cutout in Canvas (there's no path operator as
       direct as SVG's own single-path arc-to-arc trick used there), done via
       saveLayer + DST_OUT the same way any "punch a hole in this shape" Canvas drawing
       has to. */
    private void drawSleep(Canvas canvas) {
        int layer = canvas.saveLayer(0, 0, 24, 24, null);
        canvas.drawCircle(11, 12, 8, fillPaint);
        Paint cut = new Paint(Paint.ANTI_ALIAS_FLAG);
        cut.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.DST_OUT));
        canvas.drawCircle(15.5f, 9, 7, cut);
        canvas.restoreToCount(layer);
    }

    /* Padlock - shackle arc above a rounded body, same silhouette every lock icon uses. */
    private void drawLock(Canvas canvas) {
        rect.set(6, 3, 16, 15);
        canvas.drawArc(rect, 180, 180, false, strokePaint);
        rect.set(4, 10, 20, 22);
        canvas.drawRoundRect(rect, 2, 2, fillPaint);
    }

    /* Picture-in-picture - an outer frame with a smaller filled frame overlapping its
       bottom-right corner, the same silhouette every PiP icon uses. */
    private void drawPictureInPicture(Canvas canvas) {
        rect.set(2, 4, 22, 18);
        canvas.drawRoundRect(rect, 2, 2, strokePaint);
        rect.set(12, 11, 20, 16);
        canvas.drawRoundRect(rect, 1.5f, 1.5f, fillPaint);
    }

    /* Exact geometry port of EpisodeListIconView's own onDraw (three list lines plus a
       trailing play triangle) rather than a fresh design - this is the same "browse
       the queue" action that class's standalone button used to represent, now a menu
       row instead (see PlayerUiHelper.renderMainList's Episodes section). */
    private void drawEpisodes(Canvas canvas) {
        for (float y : new float[]{4f, 10f, 16f}) {
            rect.set(1f, y, 13f, y + 2f);
            canvas.drawRoundRect(rect, 1f, 1f, fillPaint);
        }
        path.reset();
        path.moveTo(17, 8);
        path.lineTo(17, 16);
        path.lineTo(23, 12);
        path.close();
        canvas.drawPath(path, fillPaint);
    }
}
