package com.mpotrykus.prism;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.view.View;

/* Same rationale as PlayPauseIconView - drawn rather than a "⏮"/"⏭" glyph, which sits
   in the same Unicode block as "⏸" and would hit the same font-fallback issue. */
class ChapterSkipIconView extends View {
    private final boolean forward;
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path path = new Path();

    ChapterSkipIconView(Context context, boolean forward) {
        super(context);
        this.forward = forward;
        paint.setColor(Color.WHITE);
        paint.setStyle(Paint.Style.FILL);
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float w = getWidth();
        float h = getHeight();
        float pad = w * 0.22f;
        float barWidth = w * 0.1f;
        float top = h * 0.22f;
        float bottom = h * 0.78f;
        path.reset();
        if (forward) {
            path.moveTo(pad, top);
            path.lineTo(pad, bottom);
            path.lineTo(w - pad - barWidth, h / 2f);
            path.close();
            canvas.drawPath(path, paint);
            canvas.drawRect(w - pad - barWidth, top, w - pad, bottom, paint);
        } else {
            canvas.drawRect(pad, top, pad + barWidth, bottom, paint);
            path.moveTo(w - pad, top);
            path.lineTo(w - pad, bottom);
            path.lineTo(pad + barWidth, h / 2f);
            path.close();
            canvas.drawPath(path, paint);
        }
    }
}
