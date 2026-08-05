package com.mpotrykus.streaming;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.view.View;

/* Android port of shared.js's volumeIconMarkup - same rationale as PlayPauseIconView/
   ChapterSkipIconView/SeekIconView (drawn rather than a "🔊"/"🔇" emoji glyph, which has
   default emoji presentation on every platform this app targets and renders as a
   full-color picture the mute button's white icon styling can never touch). A speaker
   cone plus two nested sound-wave arcs when unmuted, or the cone plus a diagonal slash
   when muted - same shape as the web leg's SVG, just drawn on a Canvas instead of path
   markup. */
class VolumeIconView extends View {
    private boolean muted = false;
    private final Paint fillPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint strokePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path conePath = new Path();
    private final RectF arcRect = new RectF();

    VolumeIconView(Context context) {
        super(context);
        fillPaint.setColor(Color.WHITE);
        fillPaint.setStyle(Paint.Style.FILL);
        strokePaint.setColor(Color.WHITE);
        strokePaint.setStyle(Paint.Style.STROKE);
        strokePaint.setStrokeCap(Paint.Cap.ROUND);
    }

    void setMuted(boolean muted) {
        if (this.muted == muted) return;
        this.muted = muted;
        invalidate();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float scale = Math.min(getWidth(), getHeight()) / 24f;

        conePath.reset();
        conePath.moveTo(3 * scale, 9 * scale);
        conePath.lineTo(3 * scale, 15 * scale);
        conePath.lineTo(7 * scale, 15 * scale);
        conePath.lineTo(12 * scale, 20 * scale);
        conePath.lineTo(12 * scale, 4 * scale);
        conePath.lineTo(7 * scale, 9 * scale);
        conePath.close();
        canvas.drawPath(conePath, fillPaint);

        strokePaint.setStrokeWidth(1.8f * scale);
        if (muted) {
            canvas.drawLine(16 * scale, 7 * scale, 22 * scale, 17 * scale, strokePaint);
        } else {
            arcRect.set(11 * scale, 7 * scale, 17 * scale, 17 * scale);
            canvas.drawArc(arcRect, -55f, 110f, false, strokePaint);
            arcRect.set(9 * scale, 3 * scale, 21 * scale, 21 * scale);
            canvas.drawArc(arcRect, -55f, 110f, false, strokePaint);
        }
    }
}
