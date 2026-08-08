package com.mpotrykus.streaming;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.view.View;

/* Drawn directly rather than a text glyph - mirrors src/player/ui/shared.js's
   episodeListIconMarkup() exactly (same 24x24 viewBox, same three list-line rects plus
   a trailing play triangle), so the Episodes button reads as the same icon on web and
   native instead of two unrelated glyphs for the same action. Same "draw it, don't rely
   on a font glyph" reasoning SeekIconView/ChapterSkipIconView already give. */
class EpisodeListIconView extends View {
    private final Paint fillPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF lineRect = new RectF();
    private final Path trianglePath = new Path();

    EpisodeListIconView(Context context) {
        super(context);
        fillPaint.setColor(Color.WHITE);
        fillPaint.setStyle(Paint.Style.FILL);
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float w = getWidth();
        float h = getHeight();
        float unit = Math.min(w, h);
        /* Same 24x24 viewBox as episodeListIconMarkup, scaled down slightly (0.75) so the
           icon doesn't touch this button's own edges, then centered within it. */
        float boxSize = unit * 0.75f;
        float scale = boxSize / 24f;
        canvas.save();
        canvas.translate((w - boxSize) / 2f, (h - boxSize) / 2f);
        canvas.scale(scale, scale);

        for (float y : new float[]{4f, 10f, 16f}) {
            lineRect.set(1f, y, 13f, y + 2f);
            canvas.drawRoundRect(lineRect, 1f, 1f, fillPaint);
        }

        trianglePath.reset();
        trianglePath.moveTo(17f, 8f);
        trianglePath.lineTo(17f, 16f);
        trianglePath.lineTo(23f, 12f);
        trianglePath.close();
        canvas.drawPath(trianglePath, fillPaint);

        canvas.restore();
    }
}
