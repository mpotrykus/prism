package com.mpotrykus.prism;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.view.View;

/* Android port of shared.js's seekIconMarkup - same rationale as PlayPauseIconView/
   ChapterSkipIconView (drawn rather than a "⏪"/"⏩" glyph, which hits the same
   fixed-color emoji-presentation problem those two already work around). A circular arc
   with an arrowhead at one end, mirrored across the vertical axis for back vs forward,
   with an unmirrored "5" label centered inside - matching the skip-5s convention HBO's
   own player uses, same as the web leg. */
class SeekIconView extends View {
    private final boolean forward;
    private final Paint strokePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint fillPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint textPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path arrowPath = new Path();
    private final RectF arcRect = new RectF();

    SeekIconView(Context context, boolean forward) {
        super(context);
        this.forward = forward;
        strokePaint.setColor(Color.WHITE);
        strokePaint.setStyle(Paint.Style.STROKE);
        strokePaint.setStrokeCap(Paint.Cap.ROUND);
        fillPaint.setColor(Color.WHITE);
        fillPaint.setStyle(Paint.Style.FILL);
        textPaint.setColor(Color.WHITE);
        textPaint.setTextAlign(Paint.Align.CENTER);
        textPaint.setFakeBoldText(true);
    }

    /* The arc spans 270 degrees, leaving a 90-degree gap at the top where the arrowhead
       sits - forward sweeps clockwise starting left-of-top, back sweeps counter-clockwise
       starting right-of-top, so the two are true mirror images of one another. The
       arrowhead triangle is built from the arc's own endpoint: its base runs along the
       radius (perpendicular to the arc's direction of travel there) and its tip extends
       further along the arc's tangent, the same "arrow riding the end of the stroke"
       shape seekIconMarkup's SVG polygon draws. */
    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float w = getWidth();
        float h = getHeight();
        float cx = w / 2f;
        float cy = h / 2f;
        float radius = Math.min(w, h) * 0.34f;
        float strokeWidth = Math.max(1.5f, Math.min(w, h) * 0.07f);
        strokePaint.setStrokeWidth(strokeWidth);
        arcRect.set(cx - radius, cy - radius, cx + radius, cy + radius);

        float sweep = forward ? 270f : -270f;
        float startAngle = forward ? 200f : -20f;
        canvas.drawArc(arcRect, startAngle, sweep, false, strokePaint);

        double endAngleRad = Math.toRadians(startAngle + sweep);
        float radialX = (float) Math.cos(endAngleRad);
        float radialY = (float) Math.sin(endAngleRad);
        float endX = cx + radius * radialX;
        float endY = cy + radius * radialY;
        /* Tangent direction of travel at the endpoint: perpendicular to the radius,
           signed so it points the way the sweep is still heading (clockwise for
           forward's positive sweep, counter-clockwise for back's negative sweep). */
        float tangentX = forward ? -radialY : radialY;
        float tangentY = forward ? radialX : -radialX;

        float arrowLength = radius * 0.7f;
        float arrowWidth = radius * 0.75f;
        float tipX = endX + tangentX * arrowLength;
        float tipY = endY + tangentY * arrowLength;
        arrowPath.reset();
        arrowPath.moveTo(tipX, tipY);
        arrowPath.lineTo(endX + radialX * arrowWidth / 2f, endY + radialY * arrowWidth / 2f);
        arrowPath.lineTo(endX - radialX * arrowWidth / 2f, endY - radialY * arrowWidth / 2f);
        arrowPath.close();
        canvas.drawPath(arrowPath, fillPaint);

        textPaint.setTextSize(Math.min(w, h) * 0.34f);
        canvas.drawText("5", cx, cy - (textPaint.ascent() + textPaint.descent()) / 2f, textPaint);
    }
}
