package com.mpotrykus.prism;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.view.View;

/* Drawn directly rather than a text glyph (the previous "▶"/"⏸" approach) - U+23F8
   PAUSE isn't covered by most system UI fonts, so devices fall back to a placeholder
   glyph for it; Samsung's fallback in particular renders it as a solid orange box
   instead of the usual hollow "tofu" outline. Drawing the shape ourselves sidesteps
   font/emoji-fallback behavior entirely. */
class PlayPauseIconView extends View {
    private boolean playing = true;
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path path = new Path();

    PlayPauseIconView(Context context) {
        super(context);
        paint.setColor(Color.WHITE);
        paint.setStyle(Paint.Style.FILL);
    }

    void setPlaying(boolean playing) {
        if (this.playing == playing) return;
        this.playing = playing;
        invalidate();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float w = getWidth();
        float h = getHeight();
        float pad = w * 0.28f;
        if (playing) {
            float barWidth = (w - pad * 2f) * 0.32f;
            float top = h * 0.2f;
            float bottom = h * 0.8f;
            canvas.drawRect(pad, top, pad + barWidth, bottom, paint);
            canvas.drawRect(w - pad - barWidth, top, w - pad, bottom, paint);
        } else {
            path.reset();
            path.moveTo(pad, h * 0.18f);
            path.lineTo(pad, h * 0.82f);
            path.lineTo(w - pad * 0.8f, h / 2f);
            path.close();
            canvas.drawPath(path, paint);
        }
    }
}
