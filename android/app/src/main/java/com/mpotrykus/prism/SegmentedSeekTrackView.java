package com.mpotrykus.prism;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.view.View;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/* Draws the entire visible seek track - played/buffered/unfilled color bands, and (when
   the session has chapters) independently-rounded per-chapter segments with a small gap
   between them - matching chrome.js's segmented scrubber on the web/Xbox leg. Sits
   behind a fully-transparent-tracked SeekBar (see PlayerUiHelper.styleSeekBar) inside a
   FrameLayout; the SeekBar itself still owns touch handling and the thumb, this view is
   purely visual.

   Unlike the web leg - which needs two different CSS-driven paths because a single
   <input> pseudo-element's background can't paint independently-rounded segments - this
   always renders through the same one-or-more-segments code path: zero chapters is just
   the one-segment case (spanning the full width, no gaps), so there's one drawing
   routine instead of a plain-gradient/segmented-divs split. */
final class SegmentedSeekTrackView extends View {
    private static final int FILLED_COLOR = Color.parseColor("#E5A00D");
    private static final int BUFFERED_COLOR = Color.parseColor("#80FFFFFF");
    private static final int UNFILLED_COLOR = Color.parseColor("#4DFFFFFF");

    private List<ChapterEntry> chapters = Collections.emptyList();
    private long durationMs;
    private long positionMs;
    private long bufferedMs;
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path clipPath = new Path();
    private final float density;

    SegmentedSeekTrackView(Context context) {
        super(context);
        density = context.getResources().getDisplayMetrics().density;
        setWillNotDraw(false);
    }

    void setChapters(List<ChapterEntry> chapters, long durationMs) {
        this.chapters = chapters != null ? chapters : Collections.emptyList();
        if (durationMs > 0) this.durationMs = durationMs;
        invalidate();
    }

    void setProgress(long positionMs, long bufferedMs, long durationMs) {
        this.positionMs = positionMs;
        this.bufferedMs = bufferedMs;
        if (durationMs > 0) this.durationMs = durationMs;
        invalidate();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float w = getWidth();
        if (durationMs <= 0 || w <= 0) return;

        float trackHeight = 3f * density;
        float y = (getHeight() - trackHeight) / 2f;
        float radius = trackHeight / 2f;
        float gapPx = 4f * density;

        /* Chapter boundaries as fractions of the full width, deduped against the
           implicit 0/1 edges - a chapter starting at (or within a hair of) either end
           would otherwise create a zero-width segment. */
        List<Float> edges = new ArrayList<>();
        edges.add(0f);
        for (ChapterEntry c : chapters) {
            float f = (float) c.startTimeOffsetMs / durationMs;
            if (f > 0.004f && f < 0.996f) edges.add(f);
        }
        edges.add(1f);
        Collections.sort(edges);

        float playedPx = clampPx((float) positionMs / durationMs * w, w);
        float bufferedPx = Math.max(playedPx, clampPx((float) bufferedMs / durationMs * w, w));

        for (int i = 0; i < edges.size() - 1; i++) {
            float left = edges.get(i) * w + (i > 0 ? gapPx / 2f : 0f);
            float right = edges.get(i + 1) * w - (i < edges.size() - 2 ? gapPx / 2f : 0f);
            if (right <= left) continue;

            float segPlayed = clampRange(playedPx, left, right);
            float segBuffered = clampRange(Math.max(bufferedPx, segPlayed), left, right);

            /* Clip to a rounded-rect silhouette for the whole segment, then paint three
               flat (non-rounded) bands inside it - the clip is what makes only the
               segment's true left/right edges round while the played/buffered/unfilled
               boundaries inside it stay sharp, the same effect the web leg gets from a
               single CSS background on one border-radius'd shape. */
            canvas.save();
            clipPath.reset();
            clipPath.addRoundRect(left, y, right, y + trackHeight, radius, radius, Path.Direction.CW);
            canvas.clipPath(clipPath);

            paint.setColor(FILLED_COLOR);
            canvas.drawRect(left, y, segPlayed, y + trackHeight, paint);
            paint.setColor(BUFFERED_COLOR);
            canvas.drawRect(segPlayed, y, segBuffered, y + trackHeight, paint);
            paint.setColor(UNFILLED_COLOR);
            canvas.drawRect(segBuffered, y, right, y + trackHeight, paint);

            canvas.restore();
        }
    }

    private static float clampPx(float px, float max) {
        return Math.max(0f, Math.min(max, px));
    }

    private static float clampRange(float px, float lo, float hi) {
        return Math.max(lo, Math.min(hi, px));
    }
}
