package com.mpotrykus.streaming;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.view.View;

/* Drawn directly rather than a "🔒" glyph - same font-fallback/fixed-color
   emoji-presentation risk PlayPauseIconView/SeekIconView/ChapterSkipIconView's own
   header comments already describe for any single dingbat-style character. A stroked
   shackle arc sitting over a filled rounded-rect body, proportioned the same
   Math.min(w,h)-relative way SeekIconView is. */
class LockIconView extends View {
    private final Paint strokePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint fillPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF shackleRect = new RectF();
    private final RectF bodyRect = new RectF();

    LockIconView(Context context) {
        super(context);
        strokePaint.setColor(Color.WHITE);
        strokePaint.setStyle(Paint.Style.STROKE);
        strokePaint.setStrokeCap(Paint.Cap.ROUND);
        fillPaint.setColor(Color.WHITE);
        fillPaint.setStyle(Paint.Style.FILL);
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float w = getWidth();
        float h = getHeight();
        float unit = Math.min(w, h);

        float bodyWidth = unit * 0.46f;
        float bodyHeight = unit * 0.36f;
        float bodyTop = h * 0.52f;
        bodyRect.set(w / 2f - bodyWidth / 2f, bodyTop, w / 2f + bodyWidth / 2f, bodyTop + bodyHeight);

        float shackleRadius = bodyWidth * 0.34f;
        float strokeWidth = Math.max(1.5f, unit * 0.08f);
        strokePaint.setStrokeWidth(strokeWidth);
        float shackleCenterY = bodyTop;
        shackleRect.set(w / 2f - shackleRadius, shackleCenterY - shackleRadius * 2f,
            w / 2f + shackleRadius, shackleCenterY);
        canvas.drawArc(shackleRect, 180f, 180f, false, strokePaint);

        float bodyRadius = unit * 0.05f;
        canvas.drawRoundRect(bodyRect, bodyRadius, bodyRadius, fillPaint);
    }
}
