package com.mpotrykus.prism;

import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.PorterDuff;
import android.graphics.drawable.ClipDrawable;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.LayerDrawable;
import android.graphics.drawable.StateListDrawable;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.view.GestureDetector;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.PopupWindow;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.TextView;
import androidx.annotation.OptIn;
import androidx.appcompat.widget.SwitchCompat;
import androidx.media3.common.C;
import androidx.media3.common.ColorInfo;
import androidx.media3.common.Format;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.DecoderCounters;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.function.Supplier;

/* Transport-bar/menu/chapter-skip chrome for PlayerActivity, pulled out into its own
   class the same way plex-player.js's web-side transport bar/menus live in
   src/player/ui/chrome.js rather than on the playback controller itself. Every method
   here takes the PlayerActivity instance as an explicit first argument and reads/writes
   its fields directly (those fields are package-private, not private, for exactly this
   reason) rather than through a narrower interface - same "one playback session's
   shared state, not a separable subsystem" reasoning the JS-side split uses.

   Visual language mirrors chrome.js's redesign directly: the amber accent color, the
   gradient transport bar with a title/remaining-time header, and the right-hugging,
   vertically-centered gradient "More" card (showPlayerMenu) standing in for chrome.js's
   own accordion sheet (openHamburgerMenu) instead of a native PopupMenu/AlertDialog. */
@OptIn(markerClass = UnstableApi.class)
final class PlayerUiHelper {
    private PlayerUiHelper() {}

    private static final int ACCENT_COLOR = Color.parseColor("#E5A00D");
    private static final int ROW_PRESSED_BG = Color.argb(26, 255, 255, 255);
    private static final int DIM_TEXT = Color.argb(166, 255, 255, 255);
    private static final int SUBTLE_TEXT = Color.argb(140, 255, 255, 255);
    private static final int VALUE_TEXT = Color.argb(102, 255, 255, 255);
    private static final int REMAINING_TEXT = Color.argb(191, 255, 255, 255);

    private static final float[] PLAYBACK_RATES = {0.25f, 0.5f, 0.75f, 1f, 1.25f, 1.5f, 2f, 4f, 8f};
    private static final int[] SLEEP_TIMER_PRESETS_MIN = {15, 30, 45, 60};
    /* Keys match the web/Xbox leg's FIT_MODES (src/player/ui/shared.js) and
       PlayerActivity.applyAspectMode's own switch on them. */
    private static final String[] ASPECT_KEYS = {"fit", "cover", "stretch"};
    private static final String[] ASPECT_LABELS = {"Fit", "Cover", "Stretch"};
    /* Same threshold as chrome.js's TITLE_PREV_RESTART_MS - how far into a title "prev"
       still counts as "just started" (jump to the actual previous queued title) rather
       than "restart this one from 0". */
    private static final long TITLE_PREV_RESTART_MS = 10000;
    /* Card width is a fraction of window width, not a flat constant - a flat dp value
       sized right for a phone in landscape reads as tiny on a tablet's much wider window.
       0.22f/160dp/260dp were picked so a ~730dp-wide phone landscape window still lands
       on the old fixed 160dp card size, while wider tablet windows scale up instead of
       leaving the row looking small. */
    private static final float EPISODE_CARD_WIDTH_FRACTION = 0.22f;
    private static final int EPISODE_CARD_MIN_WIDTH_DP = 160;
    private static final int EPISODE_CARD_MAX_WIDTH_DP = 260;
    /* The part of makeEpisodeCardView's card height that doesn't scale with card width -
       title + subtitle + summary + the gaps/padding below the thumb. Combined with the
       (width-dependent) 16:9 thumb height to size showEpisodeListLoading's placeholder so
       it doesn't visibly resize once openEpisodeListMenu replaces it with real cards. */
    private static final int EPISODE_CARD_TEXT_STACK_DP = 114;

    /* Buffering indicator - independent of fadingControls (same "contextual, not ambient
       chrome" reasoning as the skip button): it reflects actual ExoPlayer state, not user
       activity, so it has to stay visible even once the rest of the chrome has faded out
       from inactivity. Visible from creation since STATE_BUFFERING is also the player's
       state before the first prepare() completes. */
    static void buildLoadingSpinner(PlayerActivity activity) {
        activity.loadingSpinner = new ProgressBar(activity, null, android.R.attr.progressBarStyleLarge);
        activity.loadingSpinner.getIndeterminateDrawable().setColorFilter(ACCENT_COLOR, PorterDuff.Mode.SRC_IN);
        FrameLayout.LayoutParams spinnerParams =
            new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT);
        spinnerParams.gravity = Gravity.CENTER;
        activity.loadingSpinner.setLayoutParams(spinnerParams);
        activity.root.addView(activity.loadingSpinner);
    }

    /* Transparent, text-shadowed icon buttons - matches chrome.js's makeControlButton
       (no circular pill background, just a white glyph with a drop shadow for legibility
       over any frame). Anchored to a top corner with a fixed 24dp margin, same as
       chrome.js's `top: 24px` control row. */
    static void buildCloseButton(PlayerActivity activity, float density) {
        /* "‹" not "✕" - matches web-fallback.js's closeBtn, a back chevron in the
           top-left rather than an X, since this is a "back to details page" affordance
           and not a modal dismiss. */
        TextView btn = makeTopIconButton(activity, "‹", "Close", density);
        btn.setTextSize(28);
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams((int) (40 * density), (int) (40 * density));
        params.gravity = Gravity.TOP | Gravity.START;
        params.setMargins((int) (24 * density), (int) (24 * density), 0, 0);
        btn.setLayoutParams(params);
        btn.setOnClickListener(v -> activity.onBackPressed());
        activity.root.addView(btn);
        activity.registerFadingControl(btn);
    }

    /* Every custom option (speed, sleep timer, chapters, shader upscaling, audio track)
       lives behind this single button instead of one icon each - see showPlayerMenu.
       Right side, matching web-fallback.js's side:"right" for its own menu button
       (close is side:"left" there too). */
    static void buildMenuButton(PlayerActivity activity, float density) {
        TextView btn = makeTopIconButton(activity, "☰", "Player options", density);
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams((int) (40 * density), (int) (40 * density));
        params.gravity = Gravity.TOP | Gravity.END;
        params.setMargins(0, (int) (24 * density), (int) (24 * density), 0);
        btn.setLayoutParams(params);
        btn.setOnClickListener(v -> showPlayerMenu(activity, v));
        activity.root.addView(btn);
        activity.registerFadingControl(btn);
    }

    /* Touch-only (a remote/D-pad-driven device has no touch input to lock in the first
       place) - takes the slot immediately left of the hamburger (marginDp computed by
       onCreate), same "next-most-common action after the options menu" reasoning the
       old standalone Episodes button used before Episodes moved into the menu itself
       (see renderMainList) and Lock/Picture-in-Picture moved out into this row. */
    static void buildLockButton(PlayerActivity activity, float density, int marginDp) {
        MenuIconView btn = new MenuIconView(activity, MenuIconView.Icon.LOCK, Color.WHITE);
        btn.setContentDescription("Lock");
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams((int) (40 * density), (int) (40 * density));
        params.gravity = Gravity.TOP | Gravity.END;
        params.setMargins(0, (int) (24 * density), (int) (marginDp * density), 0);
        btn.setLayoutParams(params);
        btn.setOnClickListener(v -> activity.setTouchLocked(true));
        activity.root.addView(btn);
        activity.registerFadingControl(btn);
    }

    /* Always shown, unlike Lock above - entering PiP has no touchscreen dependency. */
    static void buildPipButton(PlayerActivity activity, float density, int marginDp) {
        MenuIconView btn = new MenuIconView(activity, MenuIconView.Icon.PICTURE_IN_PICTURE, Color.WHITE);
        btn.setContentDescription("Picture-in-Picture");
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams((int) (40 * density), (int) (40 * density));
        params.gravity = Gravity.TOP | Gravity.END;
        params.setMargins(0, (int) (24 * density), (int) (marginDp * density), 0);
        btn.setLayoutParams(params);
        btn.setOnClickListener(v -> activity.enterPip());
        activity.root.addView(btn);
        activity.registerFadingControl(btn);
    }

    /* Full-screen, added last in onCreate so it sits on top of every other view in z-order
       (root is a plain FrameLayout - child order is stacking order) - that's what lets it
       intercept every touch ahead of playerView's own tap/double-tap/fling/pinch
       GestureDetector and every button underneath once locked, rather than needing a
       locked-check threaded through each of those separately. Built once, toggled
       VISIBLE/GONE by setTouchLocked rather than added/removed from the view tree per
       lock/unlock cycle. A tap anywhere surfaces the "long-press here to unlock" pill, but
       onLongPress only actually unlocks if the press lands within that pill's own bounds
       (see the bounds check below) - a long-press anywhere else on the locked screen is a
       no-op, same as an accidental in-pocket press. */
    static void buildLockOverlay(PlayerActivity activity, float density) {
        FrameLayout overlay = new FrameLayout(activity);
        overlay.setVisibility(View.GONE);

        TextView message = new TextView(activity);
        message.setText("Long-press here to unlock");
        message.setTextColor(Color.WHITE);
        message.setTextSize(14);
        GradientDrawable messageBg = new GradientDrawable();
        messageBg.setColor(Color.argb(191, 0, 0, 0));
        messageBg.setCornerRadius(20 * density);
        message.setBackground(messageBg);
        int padH = (int) (18 * density);
        int padV = (int) (12 * density);
        message.setPadding(padH, padV, padH, padV);
        message.setVisibility(View.GONE);
        FrameLayout.LayoutParams messageParams =
            new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT);
        messageParams.gravity = Gravity.CENTER;
        message.setLayoutParams(messageParams);
        overlay.addView(message);

        GestureDetector detector = new GestureDetector(activity, new GestureDetector.SimpleOnGestureListener() {
            @Override
            public boolean onDown(MotionEvent e) {
                return true;
            }

            @Override
            public boolean onSingleTapConfirmed(MotionEvent e) {
                activity.showLockMessage();
                return true;
            }

            @Override
            public void onLongPress(MotionEvent e) {
                /* message's Left/Top/Right/Bottom are in overlay's own coordinate space
                   (it's a direct child laid out via CENTER gravity), same space e.getX()/
                   getY() arrive in since the detector is fed from overlay's own touch
                   listener - no coordinate translation needed. */
                if (message.getVisibility() == View.VISIBLE
                        && e.getX() >= message.getLeft() && e.getX() <= message.getRight()
                        && e.getY() >= message.getTop() && e.getY() <= message.getBottom()) {
                    activity.setTouchLocked(false);
                }
            }
        });
        /* Always returns true - this overlay is the only touch consumer once visible,
           same "every event in the gesture, not just its start" reasoning
           PlayerActivity's own playerView touch listener uses. */
        overlay.setOnTouchListener((v, event) -> {
            detector.onTouchEvent(event);
            return true;
        });

        overlay.setLayoutParams(new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        activity.root.addView(overlay);
        activity.lockOverlay = overlay;
        activity.lockMessageView = message;
    }

    /* "Performance Overlay" gear-menu toggle - a small monospace stats readout, added
       here (not lazily on first toggle like the shader canvas/ambient glow) since it's
       cheap to build and this keeps every corner overlay's construction in one place.
       Same 24dp/24dp top-left margin as the close button (see buildCloseButton) - this
       TextView isn't clickable so it doesn't steal the close button's touches even
       though it visually sits on top of it. Independent of fadingControls - same
       "contextual, not ambient chrome" reasoning as the buffering spinner, since a debug
       overlay should stay visible even once the rest of the chrome fades from
       inactivity, not disappear right when you're trying to read it. */
    static void buildStatsOverlay(PlayerActivity activity, float density) {
        TextView text = new TextView(activity);
        text.setTypeface(android.graphics.Typeface.MONOSPACE);
        text.setTextSize(11);
        text.setTextColor(Color.WHITE);
        text.setLineSpacing(2f * density, 1f);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.argb(140, 0, 0, 0));
        bg.setCornerRadius(6 * density);
        text.setBackground(bg);
        int pad = (int) (8 * density);
        text.setPadding(pad, pad, pad, pad);
        FrameLayout.LayoutParams params =
            new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT);
        params.gravity = Gravity.TOP | Gravity.START;
        params.setMargins((int) (24 * density), (int) (24 * density), 0, 0);
        text.setLayoutParams(params);
        text.setVisibility(activity.statsOverlayEnabled ? View.VISIBLE : View.GONE);
        activity.root.addView(text);
        activity.statsOverlayText = text;
        updateStatsOverlay(activity);
    }

    /* Called from PlayerActivity's ~1s reportProgress tick and immediately on every
       applyVideoEffects()/setStatsOverlayEnabled() call, rather than owning its own
       timer - a debug readout doesn't need faster-than-1s refresh on its own, but
       shouldn't visibly lag a toggle flip either. No-ops if the overlay was never
       toggled on or the view hasn't been built yet. */
    static void updateStatsOverlay(PlayerActivity activity) {
        TextView text = activity.statsOverlayText;
        if (text == null || !activity.statsOverlayEnabled) return;

        Format format = activity.selectedVideoFormat();
        ColorInfo colorInfo = format != null ? format.colorInfo : null;
        StringBuilder resolutionLine = new StringBuilder();
        resolutionLine.append(format != null && format.width > 0 ? format.width + "x" + format.height : "? x ?");
        if (format != null && format.frameRate != Format.NO_VALUE && format.frameRate > 0) {
            resolutionLine.append(" @ ").append(formatFps(format.frameRate)).append("fps");
        }
        if (colorInfo != null) {
            resolutionLine.append(" (").append(colorSpaceLabel(colorInfo.colorSpace)).append(')');
        }

        boolean hdr = activity.isHdrContent();
        StringBuilder hdrLine = new StringBuilder("HDR: ").append(hdr ? "yes" : "no");
        if (colorInfo != null) {
            hdrLine.append(" (").append(colorTransferLabel(colorInfo.colorTransfer)).append(')');
        }

        /* Web leg's dropped-frames line reads getVideoPlaybackQuality() straight off the
           <video> element - DecoderCounters is ExoPlayer's equivalent, but unlike that
           browser API its fields are only synced to the app thread on demand. */
        String droppedFramesLine = null;
        if (activity.player != null) {
            DecoderCounters counters = activity.player.getVideoDecoderCounters();
            if (counters != null) {
                counters.ensureUpdated();
                int totalFrames = counters.renderedOutputBufferCount + counters.droppedBufferCount;
                droppedFramesLine = "Dropped frames: " + counters.droppedBufferCount + "/" + totalFrames;
            }
        }

        Format audioFormat = activity.selectedAudioFormat();
        String audioLine = null;
        if (audioFormat != null) {
            StringBuilder line = new StringBuilder("Audio: ").append(audioCodecLabel(audioFormat.sampleMimeType));
            if (audioFormat.channelCount != Format.NO_VALUE && audioFormat.channelCount > 0) {
                line.append(' ').append(audioFormat.channelCount).append("ch");
            }
            if (audioFormat.sampleRate != Format.NO_VALUE && audioFormat.sampleRate > 0) {
                line.append(' ').append(audioFormat.sampleRate).append("Hz");
            }
            audioLine = line.toString();
        }

        float shownUpscaleStrength = activity.upscaleAuto ? activity.autoUpscaleStrength : activity.upscaleStrength;
        String shaderLine = "Shader Upscaling: " + (activity.shaderType == ShaderType.OFF
            ? "off"
            : activity.shaderType.label + " @ " + Math.round(shownUpscaleStrength * 100) + "%"
                + (activity.upscaleAuto ? " (auto)" : ""));
        boolean satOn = activity.colorBoostSaturationEnabled;
        boolean conOn = activity.colorBoostContrastEnabled;
        float shownColorBoostSaturation = activity.colorBoostSaturationAuto ? activity.autoColorBoostSaturationStrength : activity.colorBoostSaturationStrength;
        float shownColorBoostContrast = activity.colorBoostContrastAuto ? activity.autoColorBoostContrastStrength : activity.colorBoostContrastStrength;
        String satPart = satOn ? "sat " + Math.round(shownColorBoostSaturation * 100) + "%" + (activity.colorBoostSaturationAuto ? " (auto)" : "") : "sat off";
        String conPart = conOn ? "con " + Math.round(shownColorBoostContrast * 100) + "%" + (activity.colorBoostContrastAuto ? " (auto)" : "") : "con off";
        String colorBoostLine = "Color Boost: " + (!satOn && !conOn ? "off" : satPart + ", " + conPart);
        String aiUpscalingLine = "AI Upscaling: " + (!activity.aiUpscalingEnabled
            ? "off"
            : (activity.activeAiUpscaleProgram != null ? activity.activeAiUpscaleProgram.statusLabel() : "starting..."));

        String qualityCapLine = "Quality cap: " + (activity.qualityCapKbps != null ? activity.qualityCapKbps + " kbps" : "original")
            + (activity.autoQualityEnabled ? " (auto)" : "");
        String abrLine = activity.abrMonitor != null ? activity.abrMonitor.debugLine() : null;
        String bufferLine = activity.player != null
            ? "Buffer: " + (activity.player.getTotalBufferedDuration() / 1000f) + "s"
            : null;

        StringBuilder sb = new StringBuilder();
        sb.append(resolutionLine).append('\n').append(hdrLine);
        if (droppedFramesLine != null) sb.append('\n').append(droppedFramesLine);
        if (audioLine != null) sb.append('\n').append(audioLine);
        sb.append('\n').append(shaderLine).append('\n').append(aiUpscalingLine).append('\n').append(colorBoostLine).append('\n').append(qualityCapLine);
        if (abrLine != null) sb.append('\n').append(abrLine);
        if (bufferLine != null) sb.append('\n').append(bufferLine);
        text.setText(sb.toString());
    }

    /* Rounds to a whole number when the source is already one (24, 30, 60) but keeps
       3-decimal precision otherwise - the common fractional NTSC rates (23.976, 29.97,
       59.94) are only meaningfully different from their whole-number neighbors at that
       precision, and collapsing them to one decimal (as the web leg's empirically-
       sampled fps line does) would make 23.976 and 24 print identically. */
    private static String formatFps(float fps) {
        int rounded = Math.round(fps);
        return rounded == fps ? String.valueOf(rounded) : String.valueOf(Math.round(fps * 1000f) / 1000f);
    }

    /* C.ColorSpace only has these three values (see androidx.media3.common.C) - no
       @IntDef-backed name() to call, so this is a plain lookup rather than reflection. */
    private static String colorSpaceLabel(int colorSpace) {
        switch (colorSpace) {
            case C.COLOR_SPACE_BT601: return "bt601";
            case C.COLOR_SPACE_BT709: return "bt709";
            case C.COLOR_SPACE_BT2020: return "bt2020";
            default: return "unknown(" + colorSpace + ")";
        }
    }

    /* Only the transfer functions isHdrContent() itself checks for (ST2084/HLG) plus the
       common SDR ones get a name - anything else falls back to the raw int rather than
       guessing a label for a curve this app doesn't otherwise care about. */
    private static String colorTransferLabel(int colorTransfer) {
        switch (colorTransfer) {
            case C.COLOR_TRANSFER_SDR: return "sdr";
            case C.COLOR_TRANSFER_ST2084: return "pq";
            case C.COLOR_TRANSFER_HLG: return "hlg";
            case C.COLOR_TRANSFER_LINEAR: return "linear";
            case C.COLOR_TRANSFER_SRGB: return "srgb";
            case C.COLOR_TRANSFER_GAMMA_2_2: return "gamma2.2";
            default: return "unknown(" + colorTransfer + ")";
        }
    }

    /* MimeTypes.AUDIO_* constants are already human-readable-ish ("audio/eac3") - this
       just shortens the common ones to their plain codec name; anything not listed falls
       back to the mime type's own subtype rather than an opaque "unknown(...)", since
       unlike the int color constants above, the mime string itself is still legible. */
    private static String audioCodecLabel(String mimeType) {
        if (mimeType == null) return "unknown";
        if (mimeType.equals(MimeTypes.AUDIO_AAC)) return "aac";
        if (mimeType.equals(MimeTypes.AUDIO_AC3)) return "ac3";
        if (mimeType.equals(MimeTypes.AUDIO_E_AC3)) return "eac3";
        if (mimeType.equals(MimeTypes.AUDIO_E_AC3_JOC)) return "eac3-joc (atmos)";
        if (mimeType.equals(MimeTypes.AUDIO_AC4)) return "ac4";
        if (mimeType.equals(MimeTypes.AUDIO_TRUEHD)) return "truehd";
        if (mimeType.equals(MimeTypes.AUDIO_DTS)) return "dts";
        if (mimeType.equals(MimeTypes.AUDIO_DTS_HD)) return "dts-hd";
        if (mimeType.equals(MimeTypes.AUDIO_DTS_EXPRESS)) return "dts-express";
        if (mimeType.equals(MimeTypes.AUDIO_DTS_X)) return "dts-x";
        if (mimeType.equals(MimeTypes.AUDIO_OPUS)) return "opus";
        if (mimeType.equals(MimeTypes.AUDIO_FLAC)) return "flac";
        if (mimeType.equals(MimeTypes.AUDIO_RAW)) return "pcm";
        if (mimeType.equals(MimeTypes.AUDIO_MPEG)) return "mp3";
        return mimeType.startsWith("audio/") ? mimeType.substring("audio/".length()) : mimeType;
    }

    private static TextView makeTopIconButton(PlayerActivity activity, String glyph, String contentDescription, float density) {
        TextView btn = new TextView(activity);
        btn.setText(glyph);
        btn.setContentDescription(contentDescription);
        btn.setTextColor(Color.WHITE);
        btn.setTextSize(20);
        btn.setGravity(Gravity.CENTER);
        btn.setBackground(null);
        btn.setShadowLayer(4f * density, 0f, density, Color.argb(217, 0, 0, 0));
        return btn;
    }

    /* Bottom transport bar, redesigned to match chrome.js's buildTransportBar: a
       transparent-to-black gradient (not a flat translucent color) holding a
       title/subtitle-vs-remaining-time header row, an amber-accented scrub bar, and a
       three-cell controls row (empty left spacer, centered play/pause + seek/chapter
       buttons, mute pinned to the right) - replacing the old flat time/seekbar/mute row
       and the separate floating center-controls overlay this used to render mid-screen. */
    static void buildTransportBar(PlayerActivity activity, float density) {
        LinearLayout bar = new LinearLayout(activity);
        bar.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable gradient = new GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP,
            new int[]{Color.argb(209, 0, 0, 0), Color.argb(140, 0, 0, 0), Color.argb(0, 0, 0, 0)});
        bar.setBackground(gradient);
        int topPad = (int) (56 * density);
        int sidePad = (int) (20 * density);
        int bottomPad = (int) (14 * density);
        bar.setPadding(sidePad, topPad, sidePad, bottomPad);

        LinearLayout infoRow = new LinearLayout(activity);
        infoRow.setOrientation(LinearLayout.HORIZONTAL);
        infoRow.setGravity(Gravity.CENTER_VERTICAL);

        LinearLayout titleBlock = new LinearLayout(activity);
        titleBlock.setOrientation(LinearLayout.VERTICAL);
        titleBlock.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        TextView titleLine = new TextView(activity);
        titleLine.setText(activity.title);
        titleLine.setTextColor(Color.WHITE);
        titleLine.setTextSize(16);
        titleLine.setTypeface(titleLine.getTypeface(), android.graphics.Typeface.BOLD);
        titleLine.setMaxLines(1);
        titleLine.setEllipsize(TextUtils.TruncateAt.END);
        titleBlock.addView(titleLine);

        String subtitle = buildSubtitle(activity);
        if (!subtitle.isEmpty()) {
            TextView subtitleLine = new TextView(activity);
            subtitleLine.setText(subtitle);
            subtitleLine.setTextColor(DIM_TEXT);
            subtitleLine.setTextSize(12);
            LinearLayout.LayoutParams subParams =
                new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            subParams.topMargin = (int) (2 * density);
            subtitleLine.setLayoutParams(subParams);
            titleBlock.addView(subtitleLine);
        }
        infoRow.addView(titleBlock);

        activity.timeRemainingText = new TextView(activity);
        activity.timeRemainingText.setText("-0:00");
        activity.timeRemainingText.setTextColor(REMAINING_TEXT);
        activity.timeRemainingText.setTextSize(12);
        infoRow.addView(activity.timeRemainingText);
        bar.addView(infoRow);

        /* FrameLayout so SegmentedSeekTrackView (added first, so it renders behind) and
           transportSeekBar can occupy the exact same bounds - the SeekBar owns touch/
           thumb, the View underneath owns 100% of the visible track. Explicit 24dp
           height (rather than WRAP_CONTENT, which the SeekBar previously drove) matches
           chrome.js's own explicit 24px hit-target bump on the web leg. */
        FrameLayout seekWrap = new FrameLayout(activity);
        LinearLayout.LayoutParams seekWrapParams =
            new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, Math.round(24 * density));
        seekWrapParams.topMargin = (int) (8 * density);
        seekWrap.setLayoutParams(seekWrapParams);

        activity.segmentedTrack = new SegmentedSeekTrackView(activity);
        seekWrap.addView(activity.segmentedTrack, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        activity.segmentedTrack.setChapters(activity.chapters, 0L);

        activity.transportSeekBar = new SeekBar(activity);
        styleSeekBar(activity.transportSeekBar, density);
        activity.transportSeekBar.setMax(1000);
        seekWrap.addView(activity.transportSeekBar, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        activity.transportSeekBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar seekBar, int progress, boolean fromUser) {
                if (fromUser && activity.player != null) {
                    long duration = activity.player.getDuration();
                    if (duration != androidx.media3.common.C.TIME_UNSET && duration > 0) {
                        long previewMs = progress * duration / 1000;
                        activity.timeRemainingText.setText("-" + formatTimestamp(duration - previewMs));
                        syncSegmentedTrack(activity, previewMs);
                        showScrubPreview(activity, seekBar, progress, duration, density);
                    }
                }
            }

            @Override
            public void onStartTrackingTouch(SeekBar seekBar) {
                activity.seekBarScrubbing = true;
                showControlsTemporarily(activity);
            }

            @Override
            public void onStopTrackingTouch(SeekBar seekBar) {
                activity.seekBarScrubbing = false;
                hideScrubPreview(activity);
                if (activity.player != null) {
                    long duration = activity.player.getDuration();
                    if (duration != androidx.media3.common.C.TIME_UNSET && duration > 0) {
                        PlayerActivity.seek(seekBar.getProgress() * duration / 1000);
                    }
                }
            }
        });
        bar.addView(seekWrap);

        LinearLayout controlsRow = new LinearLayout(activity);
        controlsRow.setOrientation(LinearLayout.HORIZONTAL);
        controlsRow.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams controlsRowParams =
            new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        controlsRowParams.topMargin = (int) (4 * density);
        controlsRow.setLayoutParams(controlsRowParams);

        /* Height pinned to 0, not WRAP_CONTENT - a bare View (unlike a ViewGroup or
           TextView) doesn't shrink-to-content under an AT_MOST measure spec, it just
           reports the full available size (View.getDefaultSize() treats AT_MOST like
           EXACTLY). With WRAP_CONTENT that stretched this spacer to fill nearly the whole
           screen height, which dragged controlsRow's own wrap-content height up to match
           it, and that in turn dragged the whole transport bar's height up with it. */
        View leftCell = new View(activity);
        leftCell.setLayoutParams(new LinearLayout.LayoutParams(0, 0, 1f));
        controlsRow.addView(leftCell);

        LinearLayout centerCell = new LinearLayout(activity);
        centerCell.setOrientation(LinearLayout.HORIZONTAL);
        centerCell.setGravity(Gravity.CENTER);
        centerCell.setLayoutParams(new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        buildCenterControlsRow(activity, centerCell, density);
        controlsRow.addView(centerCell);

        /* Empty but not removed - this flex-weight-1 spacer is what balances leftCell so
           centerCell actually centers within controlsRow, even with no mute button (or
           anything else) to put in it any more. */
        View rightCell = new View(activity);
        rightCell.setLayoutParams(new LinearLayout.LayoutParams(0, 0, 1f));
        controlsRow.addView(rightCell);

        bar.addView(controlsRow);

        FrameLayout.LayoutParams barParams =
            new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT);
        barParams.gravity = Gravity.BOTTOM;
        bar.setLayoutParams(barParams);
        activity.root.addView(bar);
        activity.registerFadingControl(bar);
        /* Kept on the activity (not just a local var) so PlayerActivity.applyTitleSwitch
           can remove and rebuild this bar wholesale for the next title instead of
           reaching into its title/subtitle/chapter-button internals piecemeal. */
        activity.transportBarView = bar;
    }

    /* Matches chrome.js's buildTransportBar subtitleParts exactly: episode name (when
       present) ahead of "S# E#", joined with the same "  •  " separator, falling back to
       just the year for a movie. */
    private static String buildSubtitle(PlayerActivity activity) {
        if (activity.seasonNumber >= 0 && activity.episodeNumber >= 0) {
            String seasonEpisode = "S" + activity.seasonNumber + " E" + activity.episodeNumber;
            if (!activity.episodeTitle.isEmpty()) {
                return activity.episodeTitle + "  •  " + seasonEpisode;
            }
            return seasonEpisode;
        }
        if (activity.year >= 0) {
            return String.valueOf(activity.year);
        }
        return "";
    }

    /* Back-5s/forward-5s seek buttons flanking a gap where play/pause used to sit, with
       chapter nav further out when the session has chapters - play/pause and title nav
       (prev/next episode, playlist/collection item, or just "restart this movie") now
       live in their own floating overlay mid-screen instead (see
       buildFloatingPlaybackControls), the "separate floating center-controls overlay"
       an earlier version of this transport bar's own header comment mentions replacing -
       this brings a piece of that back for the two most important controls specifically,
       while seek/chapter (secondary, and touch devices never see them anyway - see below)
       stay put in the bottom bar.

       Both button pairs here are skipped on a device that reports a touchscreen
       (activity.hasTouchscreen, see PlayerActivity.onCreate): double-tap left/right on the
       video surface does the same 5s seek instead (see PlayerActivity's
       tapGestureDetector). Chapter nav has no gesture replacement of its own yet - it's
       just hidden on touch, reachable instead via the Chapters entry in the More menu
       (see openChapterListMenu). Fire TV/remote-driven devices report no touchscreen and have
       no way to produce that gesture, so they keep both button pairs - reachable the same
       way every other button in this row is, via Android's default D-pad focus
       navigation, no extra code needed. */
    private static void buildCenterControlsRow(PlayerActivity activity, LinearLayout row, float density) {
        int gapPx = (int) (14 * density);
        int chapterSizePx = (int) (36 * density);
        int seekSizePx = (int) (44 * density);
        boolean showSeekButtons = !activity.hasTouchscreen;
        boolean showChapterButtons = !activity.chapters.isEmpty() && !activity.hasTouchscreen;

        if (showChapterButtons) {
            row.addView(makeChapterSkipButton(activity, false), marginEndParams(chapterSizePx, gapPx));
        }

        if (showSeekButtons) {
            row.addView(makeSeekButton(activity, false), marginEndParams(seekSizePx, gapPx));
        }

        if (showSeekButtons) {
            row.addView(makeSeekButton(activity, true), marginEndParams(seekSizePx, gapPx));
        }

        if (showChapterButtons) {
            row.addView(makeChapterSkipButton(activity, true), marginEndParams(chapterSizePx, gapPx));
        }
    }

    /* Play/pause and title nav (prev/next episode, playlist/collection item, or just
       "restart this movie"), floating mid-screen rather than tucked into the bottom
       transport bar - the two controls worth a big, unmissable hit target front and
       center, same reasoning most streaming apps' TV UIs use. Title nav is always shown
       on a non-touch device, unlike chapter nav: prev is always a real action (restart,
       even with no queue at all) and next just greys out rather than disappearing when
       there's nothing queued after this title - see makeTitleSkipButton/
       seekToAdjacentTitle - so a movie played on its own still gets both buttons, just
       with next disabled. Title nav is skipped entirely on a touchscreen device (see
       buildCenterControlsRow's header comment) - touch reaches the same queue via the
       Episodes bottom sheet in the More menu instead (see openEpisodeListMenu) - only
       play/pause, which has no menu equivalent, is unconditional. Registered as one
       fading control (not per-button) like every other chrome group - see
       registerFadingControl. */
    static void buildFloatingPlaybackControls(PlayerActivity activity, float density) {
        int gapPx = (int) (14 * density);
        int chapterSizePx = (int) (36 * density);
        int playSizePx = (int) (60 * density);
        boolean showTitleButtons = !activity.hasTouchscreen;
        boolean nextTitleEnabled = activity.queueIndex >= 0 && activity.queueIndex < activity.queueLength - 1;

        LinearLayout row = new LinearLayout(activity);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER);

        if (showTitleButtons) {
            row.addView(makeTitleSkipButton(activity, false, true), marginEndParams(chapterSizePx, gapPx));
        }

        activity.playPauseButton = new PlayPauseIconView(activity);
        activity.playPauseButton.setOnClickListener(v -> {
            if (activity.player != null) activity.player.setPlayWhenReady(!activity.player.getPlayWhenReady());
            showControlsTemporarily(activity);
        });
        row.addView(activity.playPauseButton, showTitleButtons ? marginEndParams(playSizePx, gapPx) : new LinearLayout.LayoutParams(playSizePx, playSizePx));

        if (showTitleButtons) {
            row.addView(makeTitleSkipButton(activity, true, nextTitleEnabled), new LinearLayout.LayoutParams(chapterSizePx, chapterSizePx));
        }

        FrameLayout.LayoutParams rowParams = new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT);
        rowParams.gravity = Gravity.CENTER;
        row.setLayoutParams(rowParams);
        activity.root.addView(row);
        activity.registerFadingControl(row);
        /* Same reasoning as transportBarView above - lets applyTitleSwitch rebuild this
           row wholesale (its next-title-enabled state depends on the new queueIndex/
           queueLength) instead of reaching into it after the fact. */
        activity.floatingControlsView = row;
    }

    private static LinearLayout.LayoutParams marginEndParams(int sizePx, int marginEndPx) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(sizePx, sizePx);
        params.setMarginEnd(marginEndPx);
        return params;
    }

    private static View makeSeekButton(PlayerActivity activity, boolean forward) {
        SeekIconView btn = new SeekIconView(activity, forward);
        btn.setContentDescription(forward ? "Forward 5 seconds" : "Back 5 seconds");
        btn.setOnClickListener(v -> {
            if (activity.player == null) return;
            long duration = activity.player.getDuration();
            long target = activity.player.getCurrentPosition() + (forward ? 5000 : -5000);
            target = Math.max(0, target);
            if (duration != androidx.media3.common.C.TIME_UNSET && duration > 0) {
                target = Math.min(duration, target);
            }
            PlayerActivity.seek(target);
            showControlsTemporarily(activity);
        });
        return btn;
    }

    /* forward=true seeks to the next chapter's start; forward=false restarts the current
       chapter once more than a few seconds into it (else jumps to the previous chapter) -
       the same convention as prev-track buttons on physical media remotes. */
    private static View makeChapterSkipButton(PlayerActivity activity, boolean forward) {
        ChapterSkipIconView btn = new ChapterSkipIconView(activity, forward);
        btn.setContentDescription(forward ? "Next chapter" : "Previous chapter");
        btn.setOnClickListener(v -> {
            seekToAdjacentChapter(activity, forward);
            showControlsTemporarily(activity);
        });
        return btn;
    }

    private static void seekToAdjacentChapter(PlayerActivity activity, boolean forward) {
        if (activity.player == null || activity.chapters.isEmpty()) return;
        long position = activity.player.getCurrentPosition();
        if (forward) {
            for (ChapterEntry c : activity.chapters) {
                if (c.startTimeOffsetMs > position) {
                    PlayerActivity.seek(c.startTimeOffsetMs);
                    return;
                }
            }
            return;
        }
        ChapterEntry current = null;
        ChapterEntry previous = null;
        for (ChapterEntry c : activity.chapters) {
            if (c.startTimeOffsetMs <= position) {
                previous = current;
                current = c;
            } else {
                break;
            }
        }
        if (current != null && position - current.startTimeOffsetMs > 3000) {
            PlayerActivity.seek(current.startTimeOffsetMs);
        } else {
            PlayerActivity.seek(previous != null ? previous.startTimeOffsetMs : 0);
        }
    }

    /* Reuses ChapterSkipIconView for the glyph - its forward/back triangle-plus-bar shape
       already matches chrome.js's skipIconMarkup single-triangle (title) variant, so
       there's no need for a second icon class just to draw the same shape at a different
       size. enabled=false (only ever the "next" button, see buildCenterControlsRow) skips
       attaching a click listener entirely and dims the glyph, mirroring makeTitleNavButton
       on the web leg rather than hiding the button outright. */
    private static View makeTitleSkipButton(PlayerActivity activity, boolean forward, boolean enabled) {
        ChapterSkipIconView btn = new ChapterSkipIconView(activity, forward);
        btn.setContentDescription(forward ? "Next title" : "Previous title");
        btn.setAlpha(enabled ? 1f : 0.4f);
        if (enabled) {
            btn.setOnClickListener(v -> {
                seekToAdjacentTitle(activity, forward);
                showControlsTemporarily(activity);
            });
        }
        return btn;
    }

    /* "Next" always jumps forward to the next queued title - only ever called with
       forward=true when that's actually possible (see makeTitleSkipButton's enabled
       check). "Prev" jumps back to the actual previous queued title only when
       one exists and playback is still within TITLE_PREV_RESTART_MS of the start;
       otherwise it just restarts the current title from 0, the same convention
       seekToAdjacentChapter above uses for prev-track buttons. Either jump is reported
       back to JS as a bare index (see PlayerActivity.requestTitleNav) rather than
       resolved here - the actual Plex metadata fetch for whichever adjacent title gets
       requested belongs to plex-player.js's fetchQueuedTitle/playQueuedTitle, one
       implementation shared with the web leg instead of duplicated into Java. */
    private static void seekToAdjacentTitle(PlayerActivity activity, boolean forward) {
        if (forward) {
            PlayerActivity.requestTitleNav(activity.queueIndex + 1);
            return;
        }
        long position = activity.player != null ? activity.player.getCurrentPosition() : 0;
        if (activity.queueIndex > 0 && position <= TITLE_PREV_RESTART_MS) {
            PlayerActivity.requestTitleNav(activity.queueIndex - 1);
            return;
        }
        PlayerActivity.seek(0);
    }

    private static void styleSeekBar(SeekBar seekBar, float density) {
        /* The track itself is no longer drawn here at all - SegmentedSeekTrackView
           (layered behind this SeekBar in a FrameLayout, see buildTransportBar) now
           owns 100% of the visible track, played/buffered/unfilled and per-chapter
           segments alike, so this SeekBar's own background/progress drawables just get
           out of the way. It still owns touch handling and the thumb. */
        seekBar.setProgressDrawable(new ColorDrawable(Color.TRANSPARENT));

        int thumbSizePx = Math.round(12 * density);
        GradientDrawable thumb = new GradientDrawable();
        thumb.setShape(GradientDrawable.OVAL);
        thumb.setColor(ACCENT_COLOR);
        thumb.setSize(thumbSizePx, thumbSizePx);
        seekBar.setThumb(thumb);
        seekBar.setThumbOffset(0);
        seekBar.setPadding(0, 0, 0, 0);
        seekBar.setSplitTrack(false);
    }

    /* Unlike transportSeekBar above, the Effects panel's three sliders (shader/color
       boost strength, ambient opacity - see buildShaderEffectRow/etc) aren't layered
       over a SegmentedSeekTrackView; each is the only visible representation of its own
       track, so it needs a real progress drawable rather than styleSeekBar's
       transparent one. */
    private static void styleMenuSeekBar(SeekBar seekBar, float density) {
        int trackHeightPx = Math.round(3 * density);

        GradientDrawable trackBg = new GradientDrawable();
        trackBg.setShape(GradientDrawable.RECTANGLE);
        trackBg.setCornerRadius(trackHeightPx / 2f);
        trackBg.setColor(Color.argb(64, 255, 255, 255));

        GradientDrawable trackFill = new GradientDrawable();
        trackFill.setShape(GradientDrawable.RECTANGLE);
        trackFill.setCornerRadius(trackHeightPx / 2f);
        trackFill.setColor(ACCENT_COLOR);
        ClipDrawable clip = new ClipDrawable(trackFill, Gravity.START, ClipDrawable.HORIZONTAL);

        LayerDrawable progressDrawable = new LayerDrawable(new Drawable[]{trackBg, clip});
        progressDrawable.setId(0, android.R.id.background);
        progressDrawable.setId(1, android.R.id.progress);
        progressDrawable.setLayerHeight(0, trackHeightPx);
        progressDrawable.setLayerHeight(1, trackHeightPx);
        progressDrawable.setLayerGravity(0, Gravity.CENTER_VERTICAL);
        progressDrawable.setLayerGravity(1, Gravity.CENTER_VERTICAL);
        seekBar.setProgressDrawable(progressDrawable);

        int thumbSizePx = Math.round(12 * density);
        GradientDrawable thumb = new GradientDrawable();
        thumb.setShape(GradientDrawable.OVAL);
        thumb.setColor(ACCENT_COLOR);
        thumb.setSize(thumbSizePx, thumbSizePx);
        seekBar.setThumb(thumb);
        seekBar.setThumbOffset(0);
        seekBar.setPadding(0, 0, 0, 0);
        seekBar.setSplitTrack(false);
    }

    static void showControlsTemporarily(PlayerActivity activity) {
        setControlsVisible(activity, true);
        activity.controlsFadeHandler.removeCallbacks(activity.controlsFadeRunnable);
        activity.controlsFadeHandler.postDelayed(activity.controlsFadeRunnable, PlayerActivity.CONTROLS_HIDE_DELAY_MS);
    }

    /* Fades every registered control (close button, hamburger menu, transport bar) in
       lockstep, replacing ExoPlayer's own controller-visibility fade now that its built-in
       controller is disabled (setUseController(false)) in favor of this custom chrome.
       Visibility is toggled alongside alpha, not just alpha alone - otherwise a faded-out
       transport bar spanning the full screen width would still intercept touches, creating
       a dead zone where a tap meant to bring the controls back never reaches the
       tap-to-toggle handler on the PlayerView underneath. */
    static void setControlsVisible(PlayerActivity activity, boolean visible) {
        activity.controlsVisible = visible;
        for (View v : activity.fadingControls) {
            if (visible) {
                v.setVisibility(View.VISIBLE);
                v.animate().alpha(1f).setDuration(200).start();
            } else {
                v.animate().alpha(0f).setDuration(200).withEndAction(() -> v.setVisibility(View.INVISIBLE)).start();
            }
        }
    }

    // ---- More menu: a full-width gradient bottom sheet, mirroring chrome.js's own
    // ---- accordion redesign (openHamburgerMenu) - every category expands in place
    // ---- instead of replacing the sheet with a new panel to navigate back from.

    /** One top-level row of the More sheet. */
    private static final class MenuSection {
        final String label;
        MenuIconView.Icon icon;
        Supplier<String> getValue;
        Boolean toggleChecked;
        Function<Boolean, String> onToggle;
        SectionRenderer render;
        /* Lock/Picture-in-Picture close the whole sheet before running their action;
           Effects instead navigates to a different screen within it (see
           renderEffectsList) - both are "tap this row to do something rather than
           expand/collapse it", so they share this one field. */
        Runnable onTap;
        /* Effects only - onTap navigates rather than performing a leaf action, so it
           still gets a chevron hinting at the drill-down, unlike Lock/Picture-in-
           Picture's onTap. */
        boolean showChevron;
        /* Auto-Skip Intro & Credits only so far - greys the row out (dimmed header,
           disabled switch) without touching its own toggleChecked value, same "stays
           whatever it was, just inert" reasoning as chrome-menu.js's own disabled row on
           web/Xbox. Since renderMainList fully rebuilds `list` from scratch on every
           toggle (unlike the web sheet's live rowHandles.setDisabled), the Auto-Play
           row's own onToggle just re-renders the whole list to pick this up - no handle-
           tracking needed here. */
        boolean disabled;

        MenuSection(String label) {
            this.label = label;
        }
    }

    /** Builds a section's expanded content into `content`, given callbacks to update
        this row's own header value and to collapse just this section afterward. */
    private interface SectionRenderer {
        void render(LinearLayout content, Consumer<String> setValue, Runnable collapse);
    }

    /** One item inside an expanded section's picker list (see renderPickerRows). */
    private static final class PickerItem {
        final String label;
        Runnable onSelect;

        PickerItem(String label, Runnable onSelect) {
            this.label = label;
            this.onSelect = onSelect;
        }
    }

    /** Tracks which single section is currently expanded - opening a new one collapses
        it - shared across every buildAccordionSection call for one sheet. */
    private static final class AccordionState {
        LinearLayout expandedContent;
        TextView expandedChevron;
    }

    static void showPlayerMenu(PlayerActivity activity, View anchor) {
        float density = activity.getResources().getDisplayMetrics().density;
        closePlayerMenu(activity);

        /* Hugs the right edge with a capped width, matching the same change on the web
           leg (chrome.js's own sheet) - a full-width sheet read as far too wide once
           there was real desktop/tablet-landscape screen real estate to fill. */
        int screenWidthPx = activity.getResources().getDisplayMetrics().widthPixels;
        int sheetWidthPx = Math.min(Math.round(400 * density), screenWidthPx);

        View scrim = buildMenuSheetScrim(activity);
        /* Full-height, right-hugging gradient backdrop - the header+list card inside
           it (`card` below) is what's actually vertically centered, via
           setGravity(CENTER_VERTICAL), rather than the gradient itself shrinking to
           the card's height. A full-height backdrop that shrank to a short row list's
           own height left a stretch of plain, undarkened video below a vertically-
           centered card - the backdrop needs to keep covering the full screen height
           regardless of how tall the card inside it happens to be. Matches the same
           sheet/card split chrome.js's own openHamburgerMenu uses on the web leg. */
        LinearLayout sheetContent = buildMenuSheetContainer(activity, sheetWidthPx);
        sheetContent.setGravity(Gravity.CENTER_VERTICAL);

        /* The actual visible "menu" - header plus scrollable row list, capped at ~82%
           of screen height and otherwise sized to its own content (see
           clampMenuCardHeight) - a short row list (e.g. the Effects/Extras
           sub-screens) centers as a short card rather than stretching to fill the full
           backdrop. */
        LinearLayout card = new LinearLayout(activity);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setLayoutParams(new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        sheetContent.addView(card);

        card.addView(buildMenuSheetHeader(activity, density));

        LinearLayout list = new LinearLayout(activity);
        list.setOrientation(LinearLayout.VERTICAL);

        ScrollView scroll = new ScrollView(activity);
        scroll.setVerticalScrollBarEnabled(false);
        scroll.addView(list, new ScrollView.LayoutParams(ScrollView.LayoutParams.MATCH_PARENT, ScrollView.LayoutParams.WRAP_CONTENT));
        scroll.setLayoutParams(new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        card.addView(scroll);

        renderMainList(activity, list);

        activity.root.addView(scrim);
        activity.root.addView(sheetContent);
        activity.menuScrim = scrim;
        activity.menuSheet = sheetContent;
        activity.controlsFadeHandler.removeCallbacks(activity.controlsFadeRunnable);
        setControlsVisible(activity, false);
    }

    /* Re-caps the card's ScrollView height at ~82% of screen height, or lets it size
       naturally to its own content when that's shorter - the same "shrink to content,
       then cap and scroll past it" behavior a CSS max-height gets for free, done by
       hand here since a plain LinearLayout/ScrollView pairing has no such attribute.
       Deferred via list.post() since it needs real measured widths/heights, which
       aren't available synchronously the first time this runs (before the sheet has
       ever been laid out) - `card`/`scroll` are found via list's own view ancestry
       (list -> ScrollView -> card) rather than threaded through every render*List
       call's parameters, since that ancestry is identical regardless of which screen
       built `list`'s current contents. Called at the end of every render*List
       function (renderMainList and each screen it navigates to/from), since each one
       fully replaces `list`'s content and can change the card's natural height. */
    private static void clampMenuCardHeight(PlayerActivity activity, LinearLayout list) {
        list.post(() -> {
            Object scrollParent = list.getParent();
            if (!(scrollParent instanceof ScrollView)) return;
            ScrollView scroll = (ScrollView) scrollParent;
            Object cardParent = scroll.getParent();
            if (!(cardParent instanceof LinearLayout)) return;
            LinearLayout card = (LinearLayout) cardParent;
            if (card.getWidth() == 0 || card.getChildCount() == 0) return;

            int maxHeightPx = Math.round(activity.getResources().getDisplayMetrics().heightPixels * 0.82f);
            card.measure(View.MeasureSpec.makeMeasureSpec(card.getWidth(), View.MeasureSpec.EXACTLY), View.MeasureSpec.UNSPECIFIED);
            ViewGroup.LayoutParams scrollParams = scroll.getLayoutParams();
            if (card.getMeasuredHeight() > maxHeightPx) {
                int headerHeightPx = card.getChildAt(0).getHeight();
                scrollParams.height = Math.max(0, maxHeightPx - headerHeightPx);
            } else {
                scrollParams.height = ViewGroup.LayoutParams.WRAP_CONTENT;
            }
            scroll.setLayoutParams(scrollParams);
        });
    }

    /* The sheet's default screen. Clears and rebuilds `list` in place (same element,
       new contents) rather than swapping in a second list element, so the sheet's own
       scroll region doesn't need to know which screen is currently showing - same
       reasoning renderEffectsList below uses for the "Effects" sub-screen it navigates
       to and back from. */
    private static void renderMainList(PlayerActivity activity, LinearLayout list) {
        list.removeAllViews();
        AccordionState state = new AccordionState();

        List<MenuSection> sections = new ArrayList<>();
        /* Ordered by how often a row is actually touched, not the order features
           shipped in: Episodes first (jumping to a different title is the single most
           common reason to open this menu at all, when there's a queue to jump within),
           then what-you're-watching controls (Chapters/Audio Track), since those get
           touched per-video; source/quality (Version/Quality Cap) and the Auto-Play
           toggle next; Effects/Extras/Performance Overlay last, in that order - the
           three rows here most people set once and never revisit. Lock/Picture-in-
           Picture aren't in this list at all any more, being actions rather than
           settings (see PlayerActivity.onCreate/buildLockButton/buildPipButton). */

        /* Moved into the menu from a standalone top-right icon button - same "never an
           empty/dead affordance" rule Chapters/Audio Track already follow
           (activity.queueLength > 1, mirroring web-fallback.js's own
           queueRatingKeys.length > 1 gate). Its queue fetch is a real Plex round trip
           worth a loading state, unlike Lock/Picture-in-Picture (see the top-right icon
           buttons those moved into instead), which is why this one stayed a menu row. */
        if (activity.queueLength > 1) {
            /* Same seasonNumber-present check the overlay heading (renderEpisodeListContent)
               and web's chrome.js episodesBtn use to distinguish a TV episode queue from a
               movie playlist/collection queue. */
            MenuSection episodesSection = new MenuSection(activity.seasonNumber >= 0 ? "Episodes" : "Up Next");
            episodesSection.icon = MenuIconView.Icon.EPISODES;
            episodesSection.showChevron = true;
            episodesSection.onTap = () -> {
                showEpisodeListLoading(activity);
                PlayerActivity.requestEpisodeList();
            };
            sections.add(episodesSection);
        }

        if (!activity.chapters.isEmpty()) {
            /* Opens the same horizontally-scrolling card overlay openEpisodeListMenu
               uses for browsing episodes/queue items, rather than an inline text-row
               picker - see openChapterListMenu. Closes the More sheet on the way
               there, matching how opening the Episodes overlay already closes it too. */
            MenuSection chaptersSection = new MenuSection("Chapters");
            chaptersSection.icon = MenuIconView.Icon.CHAPTERS;
            chaptersSection.showChevron = true;
            chaptersSection.onTap = () -> openChapterListMenu(activity);
            sections.add(chaptersSection);
        }

        /* Audio Track and Subtitles used to be a separate accordion row (audio only,
           gated on activity.audioStreams.size() > 1) plus no Subtitles row at all -
           merged into one row opening its own standalone dialog (see
           openAudioSubtitlesMenu), a two-column side-by-side grid rather than a screen
           inside this sheet's own single-list-of-rows shape, matching chrome.js's own
           HBO-style Audio & Subtitles overlay on the web leg. Always shown (unlike the
           old audio-only row) since subtitle search is useful even with only one audio
           track. */
        MenuSection audioSubtitlesSection = new MenuSection("Audio & Subtitles");
        audioSubtitlesSection.icon = MenuIconView.Icon.AUDIO_TRACK;
        audioSubtitlesSection.showChevron = true;
        audioSubtitlesSection.onTap = () -> openAudioSubtitlesMenu(activity);
        sections.add(audioSubtitlesSection);

        /* Version and Quality Cap used to live one level deeper, behind a "Video
           Quality" row - flattened to their own top-level sections (Version only shown
           when this item actually has more than one Media[] entry, same "never an
           empty/dead affordance" rule Audio Track follows) so changing either is one
           fewer tap, matching the same change on the web leg (see chrome.js's
           openHamburgerMenu). Quality Cap is always shown since it always has at least
           "Original" to show. */
        if (activity.mediaVersions.size() > 1) {
            MenuSection versionSection = new MenuSection("Version");
            versionSection.icon = MenuIconView.Icon.VERSION;
            versionSection.getValue = () -> {
                MediaVersionEntry current = findMediaVersion(activity, activity.currentMediaIndex);
                return current != null ? current.label : null;
            };
            versionSection.render = (content, setValue, collapse) -> renderVersionSection(activity, content, setValue, collapse);
            sections.add(versionSection);
        }

        /* Own dedicated screen (see renderQualityCapList), not an inline expand - same
           reasoning as Effects/Extras above, just for a single control. */
        MenuSection qualityCapSection = new MenuSection("Quality Cap");
        qualityCapSection.icon = MenuIconView.Icon.QUALITY_CAP;
        qualityCapSection.showChevron = true;
        qualityCapSection.getValue = () -> qualityCapDisplayLabel(activity);
        qualityCapSection.onTap = () -> renderQualityCapList(activity, list);
        sections.add(qualityCapSection);

        MenuSection autoPlaySection = new MenuSection("Auto-Play");
        /* No render - same plain on/off row as Performance Overlay below, nothing to
           drill into. Icon reuses the same "skip forward" shape ChapterSkipIconView
           draws for title/chapter nav - advancing to the next queued item is exactly
           what this toggle does. */
        autoPlaySection.icon = MenuIconView.Icon.AUTO_PLAY;
        autoPlaySection.toggleChecked = activity.autoPlayEnabled;
        autoPlaySection.onToggle = (checked) -> {
            activity.setAutoPlayEnabled(checked);
            /* Greys the row below live - renderMainList rebuilds `list` from scratch,
               so the fresh autoSkipSection it creates just picks up the new
               activity.autoPlayEnabled value, unlike the web sheet's live
               rowHandles.setDisabled (see MenuSection.disabled's own comment). */
            renderMainList(activity, list);
            return null;
        };
        sections.add(autoPlaySection);

        /* Mirrors chrome-menu.js's "autoskip" row (web+Xbox) - the one native-side gap
           that plan left open. Decision logic still lives in JS (native-bridge.js's
           progress listener already has controller._session.markers, which never
           existed natively and isn't worth plumbing over the bridge just for this) -
           this row and its pref only exist to get a toggle in front of the user and
           notify JS when it changes (see setAutoSkipIntroCreditsEnabled). */
        MenuSection autoSkipSection = new MenuSection("Auto-Skip Intro & Credits");
        autoSkipSection.icon = MenuIconView.Icon.AUTO_SKIP;
        autoSkipSection.disabled = !activity.autoPlayEnabled;
        autoSkipSection.toggleChecked = activity.autoSkipIntroCreditsEnabled;
        autoSkipSection.onToggle = (checked) -> {
            activity.setAutoSkipIntroCreditsEnabled(checked);
            return checked ? "On" : null;
        };
        sections.add(autoSkipSection);

        /* Navigates to a dedicated Shader Upscaling/Color Boost/Ambient Lighting list
           (see renderEffectsList) rather than expanding in place - three sub-controls
           read better as their own screen than squeezed inline under a fourth row. */
        MenuSection effectsSection = new MenuSection("Effects");
        effectsSection.icon = MenuIconView.Icon.EFFECTS;
        effectsSection.showChevron = true;
        effectsSection.onTap = () -> renderEffectsList(activity, list);
        sections.add(effectsSection);

        /* Same "own dedicated screen" reasoning as Effects above, for Playback Speed/
           Aspect/Sleep Timer - grouped as "Extras" since none of the three relates to
           the others the way Effects' GPU-pipeline controls do, but each is simple/
           single-picker enough that squeezing all three top-level rows down to one
           still reads as a sensible cluster (playback tweaks outside the everyday
           audio/subtitle/quality set above). */
        MenuSection extrasSection = new MenuSection("Extras");
        extrasSection.icon = MenuIconView.Icon.EXTRAS;
        extrasSection.showChevron = true;
        extrasSection.onTap = () -> renderExtrasList(activity, list);
        sections.add(extrasSection);

        MenuSection statsSection = new MenuSection("Performance Overlay");
        /* No render - nothing to drill into, unlike Shader Upscaling/Color Boost/
           Ambient Lighting above (each has a strength/opacity slider). Toggling this is
           just a View visibility flip (see setStatsOverlayEnabled), so it's a plain
           on/off row. */
        statsSection.icon = MenuIconView.Icon.PERFORMANCE;
        statsSection.toggleChecked = activity.statsOverlayEnabled;
        statsSection.onToggle = (checked) -> {
            activity.setStatsOverlayEnabled(checked);
            return checked ? "On" : null;
        };
        sections.add(statsSection);

        float density = activity.getResources().getDisplayMetrics().density;
        for (MenuSection section : sections) {
            list.addView(buildAccordionSection(activity, density, section, state));
        }
        clampMenuCardHeight(activity, list);
    }

    /* The "Effects" sub-screen (Shader Upscaling/Color Boost/Ambient Lighting) - a
       whole separate list navigated to via the main list's "Effects" row (see
       renderMainList), not an inline expansion, since three sub-controls read better
       as their own screen than squeezed under a fourth row. Its own back row returns
       to renderMainList, same "clear and rebuild `list` in place" approach. Unlike the
       main list's rows, these three are plain always-visible rows (see buildEffectRow)
       rather than accordion sections - with only three of them and every one landing
       on a SeekBar, tap-to-expand just added a step between opening "Effects" and
       reaching the control someone came here for. */
    private static void renderEffectsList(PlayerActivity activity, LinearLayout list) {
        float density = activity.getResources().getDisplayMetrics().density;
        list.removeAllViews();
        list.addView(makeBackRow(activity, density, () -> renderMainList(activity, list)));
        // Ahead of Sharpening, not after - same ordering as the web leg's Effects list once AI
        // Upscaling became its own toggle (chrome-menu-effects.js's renderEffectsList).
        buildAiUpscaleEffectRow(activity, list, density);
        buildShaderEffectRow(activity, list, density);
        buildColorBoostEffectRow(activity, list, density);
        buildAmbientEffectRow(activity, list, density);
        clampMenuCardHeight(activity, list);
    }

    /** Row + rightSide pair returned by buildEffectRow, so callers can append full-width
        content below the header (`wrap`) and drop their at-a-glance control into the
        header's right column (`rightSide`) without threading both back through a longer
        parameter list. */
    private static final class EffectRowParts {
        final LinearLayout wrap;
        final LinearLayout rightSide;

        EffectRowParts(LinearLayout wrap, LinearLayout rightSide) {
            this.wrap = wrap;
            this.rightSide = rightSide;
        }
    }

    /** Shared shell for the three Effects rows below - icon+label (and an optional
        caption under the label) on the left, whatever control belongs at a glance (mode
        buttons or a toggle) on the right, matching buildAccordionSection's header
        layout minus the chevron/click-to-expand behavior. Appends the row to `list`
        immediately; the caller appends full-width content (e.g. a SeekBar) to the
        returned `wrap` below the header line. */
    private static EffectRowParts buildEffectRow(PlayerActivity activity, LinearLayout list, float density, MenuIconView.Icon icon, String label, String caption) {
        LinearLayout wrap = new LinearLayout(activity);
        wrap.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams wrapParams = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        wrapParams.bottomMargin = Math.round(4 * density);
        wrap.setLayoutParams(wrapParams);

        LinearLayout header = new LinearLayout(activity);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        int padH = Math.round(16 * density);
        int padV = Math.round(14 * density);
        header.setPadding(padH, padV, padH, 0);
        header.setLayoutParams(new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        MenuIconView iconView = new MenuIconView(activity, icon);
        int iconSizePx = Math.round(22 * density);
        LinearLayout.LayoutParams iconParams = new LinearLayout.LayoutParams(iconSizePx, iconSizePx);
        iconParams.setMarginEnd(Math.round(12 * density));
        iconView.setLayoutParams(iconParams);
        header.addView(iconView);

        LinearLayout labelStack = new LinearLayout(activity);
        labelStack.setOrientation(LinearLayout.VERTICAL);
        labelStack.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        TextView labelEl = new TextView(activity);
        labelEl.setText(label);
        labelEl.setTextColor(Color.WHITE);
        labelEl.setTextSize(15);
        labelStack.addView(labelEl);
        if (caption != null) {
            TextView captionEl = new TextView(activity);
            captionEl.setText(caption);
            captionEl.setTextColor(VALUE_TEXT);
            captionEl.setTextSize(11);
            labelStack.addView(captionEl);
        }
        header.addView(labelStack);

        /* WRAP_CONTENT, not weighted - unlike labelStack above, this needs to hug
           whatever control the caller drops in (mode buttons or a toggle) rather than
           stretching to fill the row, so it reads as a value sitting to the right of
           the label instead of a second flexible column. */
        LinearLayout rightSide = new LinearLayout(activity);
        rightSide.setOrientation(LinearLayout.HORIZONTAL);
        rightSide.setGravity(Gravity.CENTER_VERTICAL);
        rightSide.setLayoutParams(new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        header.addView(rightSide);

        wrap.addView(header);
        list.addView(wrap);
        return new EffectRowParts(wrap, rightSide);
    }

    /* Plain On/Off toggle, no strength slider and no Auto mode - the real Anime4K CNN / FSR 1
       chain (see AiUpscalingPresets) has no intensity knob to speak of, same reasoning as the
       equivalent presets on the web leg being "strengthless". Independent of Sharpening below -
       the two now stack rather than one superseding the other (see AiUpscaleShaderProgram's own
       header comment) - and independent of Color Boost too. Reuses the SHADER icon rather than
       adding a fourth entry to MenuIconView.Icon; this and Sharpening are visually similar
       enough "GPU upscale effect" concepts that a dedicated icon isn't worth the extra draw
       code for this pass. */
    private static void buildAiUpscaleEffectRow(PlayerActivity activity, LinearLayout list, float density) {
        /* See PlayerActivity.wouldAiUpscaleSource's own comment - greys the toggle out when the
           source already fills playerView (nothing for the CNN/FSR chain to actually do), rather
           than leaving it interactive for no visible effect. */
        boolean wouldUpscale = activity.wouldAiUpscaleSource();
        String caption = wouldUpscale ? "Anime4K CNN / FSR 1" : "Anime4K CNN / FSR 1 - source already matches display";
        EffectRowParts row = buildEffectRow(activity, list, density, MenuIconView.Icon.SHADER, "AI Upscaling", caption);
        SwitchCompat toggle = new SwitchCompat(activity);
        toggle.setChecked(activity.aiUpscalingEnabled);
        toggle.setTrackTintList(toggleTrackTint());
        toggle.setThumbTintList(toggleThumbTint());
        toggle.setOnCheckedChangeListener((buttonView, checked) -> activity.setAiUpscalingEnabled(checked));
        toggle.setEnabled(wouldUpscale);
        row.rightSide.addView(toggle);
    }

    /* No more manual Off/Anime4K/Live-Action picker - detectedShaderType came from
       plex-player.js's genre-based detection before this Activity ever launched, shown
       here as read-only info via the row's caption. The SeekBar + mode row are the only
       remaining controls; dragging strength to 0% in "on" mode is what "Off" used to
       be. setVideoEffects() supports being called mid-playback (see
       PlayerActivity.applyVideoEffects's own comment), so there's no Apply/Cancel
       step. */
    private static void buildShaderEffectRow(PlayerActivity activity, LinearLayout list, float density) {
        EffectRowParts row = buildEffectRow(activity, list, density, MenuIconView.Icon.SHADER, "Shader Upscaling", "Detected: " + activity.detectedShaderType.label);
        int padH = Math.round(16 * density);

        TextView strengthLabel = new TextView(activity);
        strengthLabel.setTextColor(SUBTLE_TEXT);
        strengthLabel.setTextSize(12);
        strengthLabel.setPadding(padH, Math.round(6 * density), padH, 0);

        SeekBar strengthSeekBar = new SeekBar(activity);
        styleMenuSeekBar(strengthSeekBar, density);
        strengthSeekBar.setMax(100);
        LinearLayout.LayoutParams strengthParams =
            new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        strengthParams.topMargin = Math.round(4 * density);
        strengthParams.leftMargin = padH;
        strengthParams.rightMargin = padH;
        strengthParams.bottomMargin = Math.round(12 * density);
        strengthSeekBar.setLayoutParams(strengthParams);
        strengthSeekBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar seekBar, int progress, boolean fromUser) {
                /* Label only here, actual apply committed once on release below - no longer a
                   renderer-freeze risk (applyVideoEffects() now just pushes tuning into an
                   already-installed GL program, see PlayerActivity.setShaderStrength's own
                   comment), just avoids a SharedPreferences write and overlay refresh per drag
                   frame. */
                strengthLabel.setText("Strength: " + progress + "%");
            }

            @Override
            public void onStartTrackingTouch(SeekBar seekBar) {}

            @Override
            public void onStopTrackingTouch(SeekBar seekBar) {
                activity.setShaderStrength(seekBar.getProgress() / 100f);
            }
        });

        String[] currentMode = { activity.upscaleMode() };
        addModeRow(activity, row.rightSide, density, currentMode[0], (mode) -> {
            currentMode[0] = mode;
            activity.setUpscaleMode(mode);
            applyStrengthDisplay(strengthSeekBar, strengthLabel, mode, activity.autoUpscaleStrength, activity.upscaleStrength);
        });
        applyStrengthDisplay(strengthSeekBar, strengthLabel, currentMode[0], activity.autoUpscaleStrength, activity.upscaleStrength);
        row.wrap.addView(strengthLabel);
        row.wrap.addView(strengthSeekBar);
        startLiveAutoRefresh(strengthSeekBar, () -> {
            if ("auto".equals(currentMode[0])) {
                applyStrengthDisplay(strengthSeekBar, strengthLabel, "auto", activity.autoUpscaleStrength, activity.upscaleStrength);
            }
        });
    }

    /* One labeled TextView+SeekBar pair, shared by buildColorBoostEffectRow's Saturation
       and Contrast rows below - same "commit on release" gating buildShaderEffectRow's
       own SeekBar uses (PlayerActivity.setColorBoostSaturationStrength/
       setColorBoostContrastStrength both go through applyVideoEffects(), the same
       GL-program-rebuild-per-call hazard). */
    private static SeekBar makeStrengthSeekBar(PlayerActivity activity, float density, String label, TextView strengthLabel, Consumer<Float> onCommit) {
        int padH = Math.round(16 * density);
        SeekBar strengthSeekBar = new SeekBar(activity);
        styleMenuSeekBar(strengthSeekBar, density);
        strengthSeekBar.setMax(100);
        LinearLayout.LayoutParams strengthParams =
            new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        strengthParams.topMargin = Math.round(4 * density);
        strengthParams.leftMargin = padH;
        strengthParams.rightMargin = padH;
        strengthParams.bottomMargin = Math.round(12 * density);
        strengthSeekBar.setLayoutParams(strengthParams);
        strengthSeekBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar seekBar, int progress, boolean fromUser) {
                strengthLabel.setText(label + ": " + progress + "%");
            }

            @Override
            public void onStartTrackingTouch(SeekBar seekBar) {}

            @Override
            public void onStopTrackingTouch(SeekBar seekBar) {
                onCommit.accept(seekBar.getProgress() / 100f);
            }
        });
        return strengthSeekBar;
    }

    /* One sub-control (its own title, its own Auto|On|Off mode row, its own SeekBar) - shared
       by buildColorBoostEffectRow's Saturation and Contrast sections below. Fully independent
       now: each has its own enabled/auto pair and auto-derives from its own signal
       (avgSaturation for Saturation, lumaStdDev for Contrast - see
       AutoStrength.colorBoost/colorBoostContrast), so unlike the shared-mode-row this
       replaced, there's nothing left to couple the two through. */
    private static void buildColorBoostComponentSection(
            PlayerActivity activity, LinearLayout container, float density, String title,
            Supplier<String> modeOf, Consumer<String> setMode,
            Supplier<Float> getManualValue, Consumer<Float> setStrength, Supplier<Float> getAutoValue) {
        int padH = Math.round(16 * density);

        LinearLayout section = new LinearLayout(activity);
        section.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams sectionParams = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        sectionParams.topMargin = Math.round(8 * density);
        section.setLayoutParams(sectionParams);

        LinearLayout header = new LinearLayout(activity);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(padH, 0, padH, 0);
        header.setLayoutParams(new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        TextView titleEl = new TextView(activity);
        titleEl.setText(title);
        titleEl.setTextColor(Color.WHITE);
        titleEl.setTextSize(13);
        titleEl.setTypeface(titleEl.getTypeface(), android.graphics.Typeface.BOLD);
        titleEl.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        header.addView(titleEl);

        TextView strengthLabel = new TextView(activity);
        strengthLabel.setTextColor(SUBTLE_TEXT);
        strengthLabel.setTextSize(12);
        strengthLabel.setPadding(padH, Math.round(6 * density), padH, 0);
        SeekBar strengthSeekBar = makeStrengthSeekBar(activity, density, title, strengthLabel, setStrength);

        String[] currentMode = { modeOf.get() };
        Runnable refresh = () -> applyStrengthDisplay(strengthSeekBar, strengthLabel, title, currentMode[0], getAutoValue.get(), getManualValue.get());
        addModeRow(activity, header, density, currentMode[0], (mode) -> {
            currentMode[0] = mode;
            setMode.accept(mode);
            refresh.run();
        });
        refresh.run();

        section.addView(header);
        section.addView(strengthLabel);
        section.addView(strengthSeekBar);
        container.addView(section);
        startLiveAutoRefresh(strengthSeekBar, () -> {
            if ("auto".equals(currentMode[0])) refresh.run();
        });
    }

    /* Two fully independent controls now (Saturation, Contrast - each its own Auto/On/Off
       mode, previously one combined "Strength" knob under one shared mode row) rather than
       one shared Color Boost toggle - a viewer may want one boosted and not the other, or one
       on Auto while manually dialing in the other. */
    private static void buildColorBoostEffectRow(PlayerActivity activity, LinearLayout list, float density) {
        EffectRowParts row = buildEffectRow(activity, list, density, MenuIconView.Icon.COLOR_BOOST, "Color Boost", null);

        buildColorBoostComponentSection(activity, row.wrap, density, "Saturation",
            () -> activity.colorBoostSaturationMode(), (mode) -> activity.setColorBoostSaturationMode(mode),
            () -> activity.colorBoostSaturationStrength, (v) -> activity.setColorBoostSaturationStrength(v),
            () -> activity.autoColorBoostSaturationStrength);
        buildColorBoostComponentSection(activity, row.wrap, density, "Contrast",
            () -> activity.colorBoostContrastMode(), (mode) -> activity.setColorBoostContrastMode(mode),
            () -> activity.colorBoostContrastStrength, (v) -> activity.setColorBoostContrastStrength(v),
            () -> activity.autoColorBoostContrastStrength);
    }

    /* Same pattern as buildShaderEffectRow above, simpler since there's no auto-detected
       type to show as read-only info here, just the one opacity control plus the on/off
       toggle. Unlike strength's SeekBar, this one applies live on every
       onProgressChanged tick, not gated to onStopTrackingTouch -
       PlayerActivity.setAmbientOpacity is just a Paint.setAlpha (see
       AmbientGlowView.setGlowOpacity), not a GL program rebuild like
       applyVideoEffects, so there's no drag-frequency renderer-freeze risk to guard
       against here. */
    private static void buildAmbientEffectRow(PlayerActivity activity, LinearLayout list, float density) {
        EffectRowParts row = buildEffectRow(activity, list, density, MenuIconView.Icon.AMBIENT, "Ambient Lighting", null);
        int padH = Math.round(16 * density);

        SwitchCompat toggle = new SwitchCompat(activity);
        toggle.setChecked(activity.ambientEnabled);
        toggle.setTrackTintList(toggleTrackTint());
        toggle.setThumbTintList(toggleThumbTint());
        row.rightSide.addView(toggle);

        TextView opacityLabel = new TextView(activity);
        opacityLabel.setText("Opacity: " + Math.round(activity.ambientOpacity * 100) + "%");
        opacityLabel.setTextColor(SUBTLE_TEXT);
        opacityLabel.setTextSize(12);
        opacityLabel.setPadding(padH, Math.round(6 * density), padH, 0);
        row.wrap.addView(opacityLabel);

        SeekBar opacitySeekBar = new SeekBar(activity);
        styleMenuSeekBar(opacitySeekBar, density);
        opacitySeekBar.setMax(100);
        opacitySeekBar.setProgress(Math.round(activity.ambientOpacity * 100));
        LinearLayout.LayoutParams opacityParams =
            new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        opacityParams.topMargin = Math.round(4 * density);
        opacityParams.leftMargin = padH;
        opacityParams.rightMargin = padH;
        opacityParams.bottomMargin = Math.round(12 * density);
        opacitySeekBar.setLayoutParams(opacityParams);
        opacitySeekBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar seekBar, int progress, boolean fromUser) {
                opacityLabel.setText("Opacity: " + progress + "%");
                activity.setAmbientOpacity(progress / 100f);
            }

            @Override
            public void onStartTrackingTouch(SeekBar seekBar) {}

            @Override
            public void onStopTrackingTouch(SeekBar seekBar) {}
        });
        row.wrap.addView(opacitySeekBar);

        /* No effect running to tune while the toggle is off, same "disabled unless
           there's something to adjust" reasoning as Shader Upscaling/Color Boost's own
           strength SeekBar (see applyStrengthDisplay). */
        opacitySeekBar.setEnabled(activity.ambientEnabled);
        opacitySeekBar.setAlpha(activity.ambientEnabled ? 1f : 0.5f);
        toggle.setOnCheckedChangeListener((buttonView, checked) -> {
            activity.setAmbientEnabled(checked);
            opacitySeekBar.setEnabled(checked);
            opacitySeekBar.setAlpha(checked ? 1f : 0.5f);
        });
    }

    /* "Extras" - same dedicated-screen pattern as renderEffectsList above, for
       Playback Speed/Aspect/Sleep Timer instead of the shader/color/ambient trio. */
    private static void renderExtrasList(PlayerActivity activity, LinearLayout list) {
        float density = activity.getResources().getDisplayMetrics().density;
        list.removeAllViews();
        list.addView(makeBackRow(activity, density, () -> renderMainList(activity, list)));

        AccordionState state = new AccordionState();
        List<MenuSection> sections = new ArrayList<>();

        MenuSection speedSection = new MenuSection("Playback Speed");
        speedSection.icon = MenuIconView.Icon.SPEED;
        speedSection.getValue = () -> formatRate(activity.player != null ? activity.player.getPlaybackParameters().speed : 1f);
        speedSection.showChevron = true;
        speedSection.onTap = () -> renderSpeedList(activity, list);
        sections.add(speedSection);

        MenuSection aspectSection = new MenuSection("Aspect");
        aspectSection.icon = MenuIconView.Icon.ASPECT;
        aspectSection.getValue = () -> aspectDisplayLabel(activity);
        aspectSection.showChevron = true;
        aspectSection.onTap = () -> renderAspectList(activity, list);
        sections.add(aspectSection);

        MenuSection sleepSection = new MenuSection("Sleep Timer");
        sleepSection.icon = MenuIconView.Icon.SLEEP;
        sleepSection.getValue = () -> activity.sleepMinutes > 0 ? activity.sleepMinutes + "m" : null;
        sleepSection.showChevron = true;
        sleepSection.onTap = () -> renderSleepList(activity, list);
        sections.add(sleepSection);

        for (MenuSection section : sections) {
            list.addView(buildAccordionSection(activity, density, section, state));
        }
        clampMenuCardHeight(activity, list);
    }

    /* Own dedicated screen (matching Quality Cap/Version/Effects/Audio & Subtitles, and
       the web/Xbox leg's own renderSpeedList - see chrome-menu-extras.js) rather than an
       in-place accordion expand - reuses renderSpeedSection's picker-list body unchanged,
       `collapse` just points back at Extras instead of collapsing a row in place. */
    private static void renderSpeedList(PlayerActivity activity, LinearLayout list) {
        float density = activity.getResources().getDisplayMetrics().density;
        list.removeAllViews();
        list.addView(makeBackRow(activity, density, () -> renderExtrasList(activity, list)));
        renderSpeedSection(activity, list, (value) -> {}, () -> renderExtrasList(activity, list));
        clampMenuCardHeight(activity, list);
    }

    private static void renderAspectList(PlayerActivity activity, LinearLayout list) {
        float density = activity.getResources().getDisplayMetrics().density;
        list.removeAllViews();
        list.addView(makeBackRow(activity, density, () -> renderExtrasList(activity, list)));
        renderAspectSection(activity, list, (value) -> {}, () -> renderExtrasList(activity, list));
        clampMenuCardHeight(activity, list);
    }

    private static void renderSleepList(PlayerActivity activity, LinearLayout list) {
        float density = activity.getResources().getDisplayMetrics().density;
        list.removeAllViews();
        list.addView(makeBackRow(activity, density, () -> renderExtrasList(activity, list)));
        renderSleepSection(activity, list, (value) -> {}, () -> renderExtrasList(activity, list));
        clampMenuCardHeight(activity, list);
    }

    /** Row/content taps and the close button/scrim all funnel through here rather than
        each removing views directly, so there's one place that stays in sync with
        activity's own menuScrim/menuSheet bookkeeping - same reasoning
        closeEpisodeListMenu exists alongside the Episodes bottom sheet. */
    static void closePlayerMenu(PlayerActivity activity) {
        if (activity.menuSheet != null) {
            activity.root.removeView(activity.menuSheet);
            activity.menuSheet = null;
        }
        if (activity.menuScrim != null) {
            activity.root.removeView(activity.menuScrim);
            activity.menuScrim = null;
            showControlsTemporarily(activity);
        }
    }

    private static View buildMenuSheetScrim(PlayerActivity activity) {
        View scrim = new View(activity);
        scrim.setBackgroundColor(Color.TRANSPARENT);
        scrim.setLayoutParams(new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        scrim.setOnClickListener(v -> closePlayerMenu(activity));
        return scrim;
    }

    /* Full-height drawer hugging the right edge at a capped width (see showPlayerMenu's
       sheetWidthPx) rather than the Episodes sheet's full-width/bottom-anchored shape -
       a full-width bottom sheet read as far too wide once there was real desktop/
       tablet-landscape screen width to fill. Same frameless-gradient-into-the-video
       look as that sheet, just fading in from the right edge (where the drawer anchors)
       toward the left (into the video) instead of up from the bottom. */
    private static Drawable menuSheetGradient() {
        return new GradientDrawable(GradientDrawable.Orientation.RIGHT_LEFT, new int[]{
            Color.argb(235, 0, 0, 0),
            Color.argb(224, 0, 0, 0),
            Color.argb(128, 0, 0, 0),
            Color.argb(0, 0, 0, 0),
        });
    }

    private static LinearLayout buildMenuSheetContainer(PlayerActivity activity, int widthPx) {
        LinearLayout content = new LinearLayout(activity);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setBackground(menuSheetGradient());
        FrameLayout.LayoutParams contentParams = new FrameLayout.LayoutParams(widthPx, FrameLayout.LayoutParams.MATCH_PARENT);
        contentParams.gravity = Gravity.END;
        content.setLayoutParams(contentParams);
        return content;
    }

    private static LinearLayout buildMenuSheetHeader(PlayerActivity activity, float density) {
        LinearLayout header = new LinearLayout(activity);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        int headerPadH = Math.round(16 * density);
        int headerPadV = Math.round(12 * density);
        header.setPadding(headerPadH, headerPadV, headerPadH, headerPadV);

        TextView heading = new TextView(activity);
        heading.setText("More");
        heading.setTextColor(Color.WHITE);
        heading.setTextSize(16);
        heading.setTypeface(heading.getTypeface(), android.graphics.Typeface.BOLD);
        heading.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        header.addView(heading);

        TextView closeBtn = new TextView(activity);
        closeBtn.setText("✕");
        closeBtn.setTextColor(Color.WHITE);
        closeBtn.setTextSize(16);
        int closePad = Math.round(6 * density);
        closeBtn.setPadding(closePad, closePad, closePad, closePad);
        closeBtn.setOnClickListener(v -> closePlayerMenu(activity));
        header.addView(closeBtn);
        return header;
    }

    /* Every navigated-to sub-list (currently just Effects') gets the same dimmed,
       divider-topped "back up a level" row instead of each screen styling its own -
       distinguishes "leave this screen" from a selectable option in a way a plain row
       sharing the same style as everything else couldn't. */
    private static View makeBackRow(PlayerActivity activity, float density, Runnable onBack) {
        TextView row = new TextView(activity);
        row.setText("‹  Back");
        row.setTextColor(SUBTLE_TEXT);
        row.setTextSize(12);
        row.setTypeface(row.getTypeface(), android.graphics.Typeface.BOLD);
        row.setBackground(rowPressBackground());
        int padH = Math.round(16 * density);
        int padV = Math.round(14 * density);
        row.setPadding(padH, padV, padH, padV);
        row.setLayoutParams(new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        row.setOnClickListener(v -> onBack.run());
        return row;
    }

    /** One top-level row: header (label/value/optional toggle/optional chevron) plus,
        for sections with a `render`, a GONE-by-default content block that expands in
        place on tap - accordion, one section open at a time via `state` - instead of
        navigating to a whole new panel. `toggle` and `render` are independent - Ambient
        Lighting has both, flipping on/off without affecting whether its opacity section
        is open. Sections with only `onTap` (Lock, Picture-in-Picture) are leaf rows that
        run an action and close the whole sheet, not just this row. */
    private static LinearLayout buildAccordionSection(PlayerActivity activity, float density, MenuSection section, AccordionState state) {
        LinearLayout wrap = new LinearLayout(activity);
        wrap.setOrientation(LinearLayout.VERTICAL);
        wrap.setLayoutParams(new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        LinearLayout header = new LinearLayout(activity);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setBackground(rowPressBackground());
        int padH = Math.round(16 * density);
        int padV = Math.round(14 * density);
        header.setPadding(padH, padV, padH, padV);
        header.setLayoutParams(new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        if (section.icon != null) {
            MenuIconView iconView = new MenuIconView(activity, section.icon);
            int iconSizePx = Math.round(22 * density);
            LinearLayout.LayoutParams iconParams = new LinearLayout.LayoutParams(iconSizePx, iconSizePx);
            iconParams.setMarginEnd(Math.round(12 * density));
            iconView.setLayoutParams(iconParams);
            header.addView(iconView);
        }

        LinearLayout labelStack = new LinearLayout(activity);
        labelStack.setOrientation(LinearLayout.VERTICAL);
        labelStack.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        TextView labelEl = new TextView(activity);
        labelEl.setText(section.label);
        labelEl.setTextColor(Color.WHITE);
        labelEl.setTextSize(15);
        labelStack.addView(labelEl);
        TextView valueEl = new TextView(activity);
        valueEl.setTextColor(VALUE_TEXT);
        valueEl.setTextSize(12);
        valueEl.setVisibility(View.GONE);
        labelStack.addView(valueEl);
        header.addView(labelStack);

        Consumer<String> setValue = (text) -> {
            if (text != null) {
                valueEl.setText(text);
                valueEl.setVisibility(View.VISIBLE);
            } else {
                valueEl.setVisibility(View.GONE);
            }
        };
        setValue.accept(section.getValue != null ? section.getValue.get() : null);

        if (section.toggleChecked != null) {
            SwitchCompat toggle = new SwitchCompat(activity);
            toggle.setChecked(section.toggleChecked);
            toggle.setTrackTintList(toggleTrackTint());
            toggle.setThumbTintList(toggleThumbTint());
            toggle.setEnabled(!section.disabled);
            toggle.setOnCheckedChangeListener((buttonView, checked) ->
                setValue.accept(section.onToggle != null ? section.onToggle.apply(checked) : null));
            LinearLayout.LayoutParams toggleParams =
                new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            toggleParams.setMarginEnd(section.render != null ? Math.round(8 * density) : 0);
            toggle.setLayoutParams(toggleParams);
            header.addView(toggle);
        }
        if (section.disabled) {
            header.setAlpha(0.4f);
        }

        TextView chevron = null;
        if (section.render != null || section.showChevron) {
            chevron = new TextView(activity);
            chevron.setText("›");
            chevron.setTextColor(SUBTLE_TEXT);
            chevron.setTextSize(17);
            header.addView(chevron);
        }
        wrap.addView(header);

        if (section.render != null) {
            LinearLayout content = new LinearLayout(activity);
            content.setOrientation(LinearLayout.VERTICAL);
            content.setVisibility(View.GONE);
            content.setPadding(0, 0, 0, Math.round(12 * density));
            wrap.addView(content);

            TextView chevronF = chevron;
            boolean[] built = {false};
            Runnable collapse = () -> {
                content.setVisibility(View.GONE);
                chevronF.setRotation(0f);
                if (state.expandedContent == content) {
                    state.expandedContent = null;
                    state.expandedChevron = null;
                }
            };
            header.setOnClickListener(v -> {
                if (content.getVisibility() == View.VISIBLE) {
                    collapse.run();
                    return;
                }
                if (state.expandedContent != null) {
                    state.expandedContent.setVisibility(View.GONE);
                    if (state.expandedChevron != null) state.expandedChevron.setRotation(0f);
                }
                if (!built[0]) {
                    built[0] = true;
                    section.render.render(content, setValue, collapse);
                }
                content.setVisibility(View.VISIBLE);
                chevronF.setRotation(90f);
                state.expandedContent = content;
                state.expandedChevron = chevronF;
            });
        } else if (section.onTap != null) {
            header.setOnClickListener(v -> section.onTap.run());
        }

        /* Matches chrome.js's own buildAccordionRow, which gives every top-level row a
           borderBottom - a plain divider View here since LinearLayout has no CSS-style
           border property. */
        View divider = new View(activity);
        divider.setBackgroundColor(Color.argb(18, 255, 255, 255));
        wrap.addView(divider, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, Math.round(density)));

        return wrap;
    }

    /** Shared row look for every tap-to-pick item inside an expanded section (speed/
        sleep/audio/chapters/quality-cap/version presets) - one visual definition
        instead of each render method styling its own. */
    private static void renderPickerRows(PlayerActivity activity, LinearLayout content, float density, List<PickerItem> items) {
        renderPickerRows(activity, content, density, items, 0);
    }

    private static void renderPickerRows(PlayerActivity activity, LinearLayout content, float density, List<PickerItem> items, int rowGapDp) {
        int rowGapPx = Math.round(rowGapDp * density);
        for (int i = 0; i < items.size(); i++) {
            PickerItem item = items.get(i);
            LinearLayout row = new LinearLayout(activity);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setBackground(rowPressBackground());
            int padH = Math.round(16 * density);
            int padV = Math.round(9 * density);
            row.setPadding(padH, padV, padH, padV);
            LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            if (i < items.size() - 1) rowParams.bottomMargin = rowGapPx;
            row.setLayoutParams(rowParams);

            TextView label = new TextView(activity);
            label.setText(item.label);
            label.setTextColor(Color.WHITE);
            label.setTextSize(13);
            label.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
            row.addView(label);

            row.setOnClickListener(v -> {
                if (item.onSelect != null) item.onSelect.run();
            });
            content.addView(row);
        }
    }

    /* {label, kbps} pairs mirroring shared.js's QUALITY_CAP_PRESETS on the web leg -
       null kbps is "Original" (no cap), matched by identity in renderQualityCapSection/
       qualityCapLabel just like the web leg's own null-kbps preset. Package-private
       (not private) - QualityAbrMonitor reads this same ladder directly rather than
       hand-duplicating a third copy of it. */
    static final class QualityCapPreset {
        final String label;
        final Integer kbps;

        QualityCapPreset(String label, Integer kbps) {
            this.label = label;
            this.kbps = kbps;
        }
    }

    static final QualityCapPreset[] QUALITY_CAP_PRESETS = {
        new QualityCapPreset("Original", null),
        new QualityCapPreset("1080p (20 Mbps)", 20000),
        new QualityCapPreset("720p (10 Mbps)", 10000),
        new QualityCapPreset("480p (4 Mbps)", 4000),
        new QualityCapPreset("360p (2 Mbps)", 2000),
    };

    private static String qualityCapLabel(Integer kbps) {
        for (QualityCapPreset preset : QUALITY_CAP_PRESETS) {
            if (java.util.Objects.equals(preset.kbps, kbps)) return preset.label;
        }
        return null;
    }

    /* "Auto (720p (10 Mbps))" while Auto Quality is actively adjusting the cap, else the
       plain preset label - same "(Auto)" convention the Shader Upscaling row uses.
       Android's player is always ExoPlayer, so unlike the web leg's menu there's no
       "unavailable" branch to account for here. */
    private static String qualityCapDisplayLabel(PlayerActivity activity) {
        String label = qualityCapLabel(activity.qualityCapKbps);
        return activity.autoQualityEnabled ? "Auto (" + label + ")" : label;
    }

    private static MediaVersionEntry findMediaVersion(PlayerActivity activity, int mediaIndex) {
        for (MediaVersionEntry entry : activity.mediaVersions) {
            if (entry.mediaIndex == mediaIndex) return entry;
        }
        return null;
    }

    private static void renderVersionSection(PlayerActivity activity, LinearLayout content, Consumer<String> setValue, Runnable collapse) {
        float density = activity.getResources().getDisplayMetrics().density;
        List<PickerItem> items = new ArrayList<>();
        for (MediaVersionEntry entry : activity.mediaVersions) {
            boolean isCurrent = entry.mediaIndex == activity.currentMediaIndex;
            items.add(new PickerItem(entry.label + (isCurrent ? "  ✓" : ""), () -> {
                activity.switchMediaVersion(entry.mediaIndex);
                setValue.accept(entry.label);
                collapse.run();
            }));
        }
        renderPickerRows(activity, content, density, items);
    }

    private static void renderQualityCapSection(PlayerActivity activity, LinearLayout content, Consumer<String> setValue, Runnable collapse) {
        float density = activity.getResources().getDisplayMetrics().density;
        List<PickerItem> items = new ArrayList<>();
        items.add(new PickerItem("Auto" + (activity.autoQualityEnabled ? "  ✓" : ""), () -> {
            activity.setAutoQualityEnabled(true);
            setValue.accept(qualityCapDisplayLabel(activity));
            collapse.run();
        }));
        for (QualityCapPreset preset : QUALITY_CAP_PRESETS) {
            boolean isCurrent = !activity.autoQualityEnabled && java.util.Objects.equals(preset.kbps, activity.qualityCapKbps);
            items.add(new PickerItem(preset.label + (isCurrent ? "  ✓" : ""), () -> {
                activity.setAutoQualityEnabled(false);
                activity.switchQualityCap(preset.kbps);
                setValue.accept(qualityCapDisplayLabel(activity));
                collapse.run();
            }));
        }
        renderPickerRows(activity, content, density, items, 8);
    }

    /* "Quality Cap" navigates to its own screen (see the MenuSection.onTap case in
       buildAccordionSection) rather than expanding in place - same reasoning as
       Effects/Extras, just for one control instead of a cluster of several. Reuses
       renderQualityCapSection's picker-list body unchanged: `list` stands in for the
       accordion `content` LinearLayout it normally renders into, and navigating back to
       renderMainList (which re-derives every row's value fresh) stands in for
       `collapse`, so picking a preset here needs no separate "update this row's value"
       step of its own. */
    private static void renderQualityCapList(PlayerActivity activity, LinearLayout list) {
        float density = activity.getResources().getDisplayMetrics().density;
        list.removeAllViews();
        list.addView(makeBackRow(activity, density, () -> renderMainList(activity, list)));
        renderQualityCapSection(activity, list, (value) -> {}, () -> renderMainList(activity, list));
        clampMenuCardHeight(activity, list);
    }

    private static final String[] MODE_KEYS = { "auto", "on", "off" };
    private static final String[] MODE_LABELS = { "Auto", "On", "Off" };

    /* Shared by buildShaderEffectRow/buildColorBoostEffectRow's mode row - drives the
       SeekBar's thumb + label from the auto-resolved value while in "auto" mode, and
       only leaves the SeekBar itself interactive in "on" mode: "auto" because the value
       isn't user-driven, "off" because there's no effect running for it to tune, same
       reasoning "off" already gets a dimmed/disabled mode button of its own. Matches
       chrome.js's applyStrengthDisplay on the web leg. Safe to call setProgress() in
       every branch - unlike a plain HTML range input, SeekBar.setProgress() does fire
       onProgressChanged even for a programmatic change, but that listener only ever
       touches the label text (see buildShaderEffectRow/buildColorBoostEffectRow's own
       SeekBar listeners); the actual manual-strength commit happens in
       onStopTrackingTouch, which is gesture-only and never fires from a programmatic
       change, so there's no risk of a live auto-mode refresh (see
       startLiveAutoRefresh) clobbering the remembered manual value. */
    private static void applyStrengthDisplay(SeekBar strengthSeekBar, TextView strengthLabel, String mode, float autoValue, float manualValue) {
        applyStrengthDisplay(strengthSeekBar, strengthLabel, "Strength", mode, autoValue, manualValue);
    }

    /* Same as the 5-arg overload above, but with a caller-chosen label prefix - Color
       Boost's Saturation/Contrast rows share one mode row driving two independent
       SeekBars (see buildColorBoostEffectRow), so each needs its own label rather than
       both reading "Strength". */
    private static void applyStrengthDisplay(SeekBar strengthSeekBar, TextView strengthLabel, String label, String mode, float autoValue, float manualValue) {
        boolean auto = "auto".equals(mode);
        boolean enabled = "on".equals(mode);
        strengthSeekBar.setEnabled(enabled);
        strengthSeekBar.setAlpha(enabled ? 1f : 0.5f);
        int shown = Math.round((auto ? autoValue : manualValue) * 100);
        strengthSeekBar.setProgress(shown);
        strengthLabel.setText(label + ": " + shown + "%" + (auto ? " (auto)" : ""));
    }

    /* Ticks `refresh` while `view` stays attached to the window, then stops itself -
       used by the two Effects rows with an Auto mode (Shader Upscaling/Color Boost) to
       reflect ContentAnalysisSampler's background strength recalculation (every
       ~750ms, see its own SAMPLE_INTERVAL_MS) instead of leaving a stale snapshot from
       whenever "Auto" was last tapped. Polls attachment state rather than requiring an
       explicit teardown call, since this row can disappear via several different paths
       (back navigation, closing the whole sheet) that would otherwise each need their
       own cleanup wired in - same self-stopping approach as chrome.js's
       startLiveAutoRefresh on the web leg (which polls DOM connectedness instead). */
    private static void startLiveAutoRefresh(View view, Runnable refresh) {
        Handler handler = new Handler(Looper.getMainLooper());
        Runnable tick = new Runnable() {
            @Override
            public void run() {
                if (!view.isAttachedToWindow()) return;
                refresh.run();
                handler.postDelayed(this, 750L);
            }
        };
        handler.postDelayed(tick, 750L);
    }

    /* 3-way Auto/On/Off segmented control replacing the old separate enabled-toggle
       (hamburger row) + "Auto strength" SwitchCompat (panel) pair - see
       PlayerActivity.setUpscaleMode/setColorBoostSaturationMode/setColorBoostContrastMode
       for why the underlying shaderEnabled/upscaleAuto (colorBoostSaturationEnabled/
       colorBoostSaturationAuto and the Contrast equivalents) flags stay as they were
       rather than being replaced outright. Matches chrome.js's buildModeRow on the
       web leg: three equal-weight buttons, tap wires straight through to onModeChange +
       a strength-display refresh, no separate "commit" step. */
    /* Fixed-width buttons (not layout_weight) rather than the old evenly-filled
       full-width row - this now sits in buildEffectRow's `rightSide`, which itself
       hugs its content instead of stretching to the sheet's full width, so weighted
       0dp-width children here would hit LinearLayout's "weight inside a WRAP_CONTENT
       ancestor" measurement trap (an UNSPECIFIED/AT_MOST spec propagating down to a
       0dp+weight child can collapse or over-expand it unpredictably). A fixed width
       per button sidesteps that entirely and keeps "Auto"/"On"/"Off" equal width
       despite their different text lengths, reading as a compact segmented control
       next to the row's label. */
    private static void addModeRow(PlayerActivity activity, LinearLayout content, float density, String mode, Consumer<String> onModeChange) {
        LinearLayout row = new LinearLayout(activity);
        row.setOrientation(LinearLayout.HORIZONTAL);
        int gap = Math.round(6 * density);
        row.setLayoutParams(new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        int btnWidth = Math.round(44 * density);
        TextView[] buttons = new TextView[MODE_KEYS.length];
        for (int i = 0; i < MODE_KEYS.length; i++) {
            String key = MODE_KEYS[i];
            TextView btn = new TextView(activity);
            btn.setText(MODE_LABELS[i]);
            btn.setGravity(Gravity.CENTER);
            btn.setTextSize(12);
            btn.setTypeface(btn.getTypeface(), android.graphics.Typeface.BOLD);
            int padV = Math.round(6 * density);
            btn.setPadding(0, padV, 0, padV);
            /* Fixed width, not WRAP_CONTENT+minWidth - "Auto"/"On"/"Off" have different
               natural text widths, and minWidth only guarantees a floor, not equality,
               once any label's content happens to exceed it. */
            LinearLayout.LayoutParams btnParams = new LinearLayout.LayoutParams(btnWidth, LinearLayout.LayoutParams.WRAP_CONTENT);
            if (i > 0) btnParams.setMarginStart(gap);
            btn.setLayoutParams(btnParams);
            btn.setOnClickListener(v -> {
                onModeChange.accept(key);
                setModeButtonsSelected(buttons, key);
            });
            buttons[i] = btn;
            row.addView(btn);
        }
        setModeButtonsSelected(buttons, mode);
        content.addView(row);
    }

    private static void setModeButtonsSelected(TextView[] buttons, String selectedMode) {
        for (int i = 0; i < MODE_KEYS.length; i++) {
            boolean selected = MODE_KEYS[i].equals(selectedMode);
            GradientDrawable bg = new GradientDrawable();
            bg.setShape(GradientDrawable.RECTANGLE);
            bg.setCornerRadius(buttons[i].getResources().getDisplayMetrics().density * 6);
            if (selected) {
                bg.setColor(ACCENT_COLOR);
            } else {
                bg.setColor(Color.TRANSPARENT);
                bg.setStroke(1, Color.argb(38, 255, 255, 255));
            }
            buttons[i].setBackground(bg);
            buttons[i].setTextColor(selected ? Color.parseColor("#1A1A1A") : VALUE_TEXT);
        }
    }

    private static String formatRate(float rate) {
        return rate == Math.floor(rate) ? ((int) rate) + "x" : rate + "x";
    }

    private static void renderSpeedSection(PlayerActivity activity, LinearLayout content, Consumer<String> setValue, Runnable collapse) {
        float density = activity.getResources().getDisplayMetrics().density;
        float current = activity.player != null ? activity.player.getPlaybackParameters().speed : 1f;
        List<PickerItem> items = new ArrayList<>();
        for (float rate : PLAYBACK_RATES) {
            items.add(new PickerItem(formatRate(rate) + (rate == current ? "  ✓" : ""), () -> {
                PlayerActivity.setPlaybackSpeed(rate);
                setValue.accept(formatRate(rate));
                collapse.run();
            }));
        }
        renderPickerRows(activity, content, density, items);
    }

    private static String aspectDisplayLabel(PlayerActivity activity) {
        for (int i = 0; i < ASPECT_KEYS.length; i++) {
            if (ASPECT_KEYS[i].equals(activity.aspectMode)) return ASPECT_LABELS[i];
        }
        return ASPECT_LABELS[0];
    }

    /* Replaces the old pinch/pan zoom's own would-be menu row - see PlayerActivity's own
       zoomScale/panX/panY, a separate continuous touch gesture on the video surface that this
       doesn't change - with a plain Fit/Cover/Stretch aspect picker, matching the web/Xbox
       leg's Aspect screen (chrome-menu-extras.js's renderAspectSection). */
    private static void renderAspectSection(PlayerActivity activity, LinearLayout content, Consumer<String> setValue, Runnable collapse) {
        float density = activity.getResources().getDisplayMetrics().density;
        List<PickerItem> items = new ArrayList<>();
        for (int i = 0; i < ASPECT_KEYS.length; i++) {
            String key = ASPECT_KEYS[i];
            String label = ASPECT_LABELS[i];
            items.add(new PickerItem(label + (key.equals(activity.aspectMode) ? "  ✓" : ""), () -> {
                PlayerActivity.setAspectMode(key);
                setValue.accept(label);
                collapse.run();
            }));
        }
        renderPickerRows(activity, content, density, items);
    }

    private static void renderSleepSection(PlayerActivity activity, LinearLayout content, Consumer<String> setValue, Runnable collapse) {
        float density = activity.getResources().getDisplayMetrics().density;
        List<PickerItem> items = new ArrayList<>();
        items.add(new PickerItem("Off" + (activity.sleepMinutes == 0 ? "  ✓" : ""), () -> {
            activity.setSleepTimer(0);
            setValue.accept(null);
            collapse.run();
        }));
        for (int minutes : SLEEP_TIMER_PRESETS_MIN) {
            items.add(new PickerItem(minutes + " min" + (activity.sleepMinutes == minutes ? "  ✓" : ""), () -> {
                activity.setSleepTimer(minutes * 60_000L);
                setValue.accept(minutes + "m");
                collapse.run();
            }));
        }
        items.add(new PickerItem("End of episode", () -> {
            activity.setSleepTimer(0);
            setValue.accept(null);
            collapse.run();
        }));
        renderPickerRows(activity, content, density, items);
    }

    private static void renderAudioSection(PlayerActivity activity, LinearLayout content, Consumer<String> setValue, Runnable collapse) {
        content.removeAllViews();
        float density = activity.getResources().getDisplayMetrics().density;
        List<PickerItem> items = new ArrayList<>();
        for (AudioStreamEntry entry : activity.audioStreams) {
            boolean isCurrent = entry.id.equals(activity.currentAudioStreamId);
            items.add(new PickerItem(entry.label + (isCurrent ? "  ✓" : ""), () -> {
                activity.switchAudioStream(entry.id);
                setValue.accept(entry.label);
                collapse.run();
                /* switchAudioStream updates activity.currentAudioStreamId synchronously
                   even though applying it to the player itself may still be waiting on
                   the PUT-to-Plex round trip (see that method) - re-render in place so
                   the ✓ moves to the new selection immediately instead of only after
                   this menu is closed and reopened. */
                renderAudioSection(activity, content, setValue, collapse);
            }));
        }
        renderPickerRows(activity, content, density, items);
    }

    /* Window width, not the activity's own view width - called before the sheet (and thus
       any view to measure) exists yet for showEpisodeListLoading's placeholder. */
    private static int episodeCardWidthPx(PlayerActivity activity, float density) {
        float windowWidthDp = activity.getResources().getDisplayMetrics().widthPixels / density;
        float cardWidthDp = Math.max(EPISODE_CARD_MIN_WIDTH_DP,
            Math.min(EPISODE_CARD_MAX_WIDTH_DP, windowWidthDp * EPISODE_CARD_WIDTH_FRACTION));
        return Math.round(cardWidthDp * density);
    }

    /* Mirrors makeEpisodeCardView's own thumb sizing (cardPad + 16:9) so the loading
       placeholder's height lines up with the real cards it's approximating. */
    private static int episodeCardHeightPx(PlayerActivity activity, float density) {
        int cardWidthPx = episodeCardWidthPx(activity, density);
        int cardPad = Math.round(4 * density);
        int thumbWidthPx = cardWidthPx - cardPad * 2;
        int thumbHeightPx = Math.round(thumbWidthPx * 9f / 16f);
        return thumbHeightPx + Math.round(EPISODE_CARD_TEXT_STACK_DP * density);
    }

    /* Native counterpart to episode-list.js's openEpisodeListOverlay - matches the web
       version's own layout now: a horizontally-scrolling row of cards (thumbnail on top,
       text below) with fade-edge scroll arrows, rather than the vertical list this
       started as. Added straight into activity.root (like the transport bar/loading
       spinner) instead of a PopupWindow - confirmed on a real device via dumpsys window
       that a full-width PopupWindow's frame gets clipped ~94px short of the true left
       edge, because a PopupWindow is a separate WindowManager window that doesn't inherit
       this Activity's own layoutInDisplayCutoutMode=always, and PopupWindow exposes no
       public API to opt a popup's window into that same flag. root's window already
       renders edge-to-edge correctly (the video/transport bar prove it), so adding here
       sidesteps the whole inset problem instead of fighting it. Called only once episode
       data has actually arrived - there's nothing to show before then. */
    static void openEpisodeListMenu(PlayerActivity activity, List<EpisodeEntry> episodes) {
        float density = activity.getResources().getDisplayMetrics().density;
        closeEpisodeListMenu(activity);
        closePlayerMenu(activity);

        View scrim = buildEpisodeSheetScrim(activity);
        LinearLayout content = buildEpisodeSheetContainer(activity, density);
        content.addView(buildEpisodeSheetHeader(activity, density));

        /* Horizontal card row + fade-edge scroll arrows, mirroring episode-list.js's
           scrollWrap/buildQueueScrollArrow exactly - a FrameLayout stacking the
           HorizontalScrollView under two edge-anchored arrow buttons, rather than a
           RecyclerView, matching the plain-Views-only convention every other menu in this
           file already follows. */
        FrameLayout scrollWrap = new FrameLayout(activity);
        scrollWrap.setLayoutParams(new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        int cardWidthPx = episodeCardWidthPx(activity, density);
        int arrowWidthPx = Math.round(40 * density);

        LinearLayout row = new LinearLayout(activity);
        row.setOrientation(LinearLayout.HORIZONTAL);

        android.widget.HorizontalScrollView scroll = new android.widget.HorizontalScrollView(activity);
        scroll.setHorizontalScrollBarEnabled(false);
        scroll.setLayoutParams(new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT));
        /* clipToPadding(false) lets the first/last card scroll fully into this padded
           region instead of being clipped at the padding boundary - the padding itself
           only exists to keep resting cards clear of the arrow buttons overlaid on top,
           same reasoning episode-list.js's own scroll padding comment gives. */
        scroll.setClipToPadding(false);
        int scrollPadH = Math.round(6 * density) + arrowWidthPx;
        int scrollPadV = Math.round(12 * density);
        scroll.setPadding(scrollPadH, scrollPadV, scrollPadH, scrollPadV);
        scroll.addView(row, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        View currentCard = null;
        for (EpisodeEntry episode : episodes) {
            View card = makeEpisodeCardView(activity, density, episode, cardWidthPx);
            row.addView(card);
            if (episode.current) currentCard = card;
        }
        scrollWrap.addView(scroll);

        View leftArrow = makeEpisodeScrollArrow(activity, density, true, scroll, arrowWidthPx);
        View rightArrow = makeEpisodeScrollArrow(activity, density, false, scroll, arrowWidthPx);
        scrollWrap.addView(leftArrow);
        scrollWrap.addView(rightArrow);
        content.addView(scrollWrap);

        /* Same "visible only while there's somewhere left to scroll" rule as the web
           overlay's arrows - canScrollHorizontally already accounts for this view's
           current scroll position vs its content width, so there's no manual
           scrollWidth/clientWidth bookkeeping to keep in sync by hand. */
        Runnable updateArrows = () -> {
            leftArrow.setAlpha(scroll.canScrollHorizontally(-1) ? 1f : 0f);
            leftArrow.setClickable(scroll.canScrollHorizontally(-1));
            rightArrow.setAlpha(scroll.canScrollHorizontally(1) ? 1f : 0f);
            rightArrow.setClickable(scroll.canScrollHorizontally(1));
        };
        scroll.setOnScrollChangeListener((v, x, y, oldX, oldY) -> updateArrows.run());

        View finalCurrentCard = currentCard;
        scroll.post(() -> {
            updateArrows.run();
            /* Same "scroll the current episode into view, centered" behavior as
               episode-list.js's currentCard.scrollIntoView({inline:"center"}) - has to
               wait for layout (post) since getLeft()/getWidth() are only meaningful once
               the row has actually been measured/positioned. */
            if (finalCurrentCard != null) {
                int target = finalCurrentCard.getLeft() - (scroll.getWidth() / 2 - finalCurrentCard.getWidth() / 2);
                scroll.scrollTo(Math.max(0, target), 0);
            }
        });

        activity.root.addView(scrim);
        activity.root.addView(content);
        activity.episodeListScrim = scrim;
        activity.episodeListSheet = content;
        activity.controlsFadeHandler.removeCallbacks(activity.controlsFadeRunnable);
        setControlsVisible(activity, false);
    }

    /* Shown immediately on the Episodes row tap (see renderMainList), before JS
       has resolved the actual queue metadata (episode-list.js's getQueueItems/
       formatEpisodeListItem - a real Plex round-trip per episode on the first open of a
       given queue, not instant). openEpisodeListMenu replaces this with the real content
       once PlayerActivity.showEpisodeList arrives (both start with closeEpisodeListMenu,
       so whichever is currently showing gets torn down cleanly first). Height is derived
       from the same window-width-based card size openEpisodeListMenu will use, so the
       sheet doesn't visibly resize once the real cards replace this placeholder. */
    static void showEpisodeListLoading(PlayerActivity activity) {
        float density = activity.getResources().getDisplayMetrics().density;
        closeEpisodeListMenu(activity);
        closePlayerMenu(activity);

        View scrim = buildEpisodeSheetScrim(activity);
        LinearLayout content = buildEpisodeSheetContainer(activity, density);
        content.addView(buildEpisodeSheetHeader(activity, density));

        FrameLayout placeholder = new FrameLayout(activity);
        placeholder.setLayoutParams(new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, episodeCardHeightPx(activity, density)));

        /* Same amber-tinted indeterminate spinner as buildLoadingSpinner's buffering
           indicator, not a new style of its own. */
        ProgressBar spinner = new ProgressBar(activity, null, android.R.attr.progressBarStyleLarge);
        spinner.getIndeterminateDrawable().setColorFilter(ACCENT_COLOR, PorterDuff.Mode.SRC_IN);
        FrameLayout.LayoutParams spinnerParams = new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT);
        spinnerParams.gravity = Gravity.CENTER;
        spinner.setLayoutParams(spinnerParams);
        placeholder.addView(spinner);
        content.addView(placeholder);

        activity.root.addView(scrim);
        activity.root.addView(content);
        activity.episodeListScrim = scrim;
        activity.episodeListSheet = content;
        activity.controlsFadeHandler.removeCallbacks(activity.controlsFadeRunnable);
        setControlsVisible(activity, false);
    }

    private static View buildEpisodeSheetScrim(PlayerActivity activity) {
        View scrim = new View(activity);
        scrim.setBackgroundColor(Color.TRANSPARENT);
        scrim.setLayoutParams(new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        scrim.setOnClickListener(v -> closeEpisodeListMenu(activity));
        return scrim;
    }

    private static LinearLayout buildEpisodeSheetContainer(PlayerActivity activity, float density) {
        LinearLayout content = new LinearLayout(activity);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setBackground(episodeSheetGradient());
        /* Full width, unlike the max-width-on-tablets cap tried earlier - now that this
           is a horizontal card row (not a vertical list whose rows would otherwise
           stretch uncomfortably wide), there's no wide-row legibility problem to guard
           against. */
        FrameLayout.LayoutParams contentParams = new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT);
        contentParams.gravity = Gravity.BOTTOM;
        content.setLayoutParams(contentParams);
        return content;
    }

    private static LinearLayout buildEpisodeSheetHeader(PlayerActivity activity, float density) {
        LinearLayout header = new LinearLayout(activity);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        int headerPadH = Math.round(16 * density);
        int headerPadV = Math.round(12 * density);
        header.setPadding(headerPadH, headerPadV, headerPadH, headerPadV);

        TextView heading = new TextView(activity);
        /* Same seasonNumber-present check episode-list.js/buildTransportBar use to
           decide "Episodes" vs "Up Next" wording. */
        heading.setText(activity.seasonNumber >= 0 ? "Episodes" : "Up Next");
        heading.setTextColor(Color.WHITE);
        heading.setTextSize(16);
        heading.setTypeface(heading.getTypeface(), android.graphics.Typeface.BOLD);
        heading.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        header.addView(heading);

        TextView closeBtn = new TextView(activity);
        closeBtn.setText("✕");
        closeBtn.setTextColor(Color.WHITE);
        closeBtn.setTextSize(16);
        int closePad = Math.round(6 * density);
        closeBtn.setPadding(closePad, closePad, closePad, closePad);
        closeBtn.setOnClickListener(v -> closeEpisodeListMenu(activity));
        header.addView(closeBtn);
        return header;
    }

    /* Row/card taps and the close button/scrim above all funnel through here rather than
       each removing views directly, so there's one place that stays in sync with
       activity's own episodeListScrim/episodeListSheet bookkeeping - same reasoning
       closePlayerMenu exists alongside the More sheet. */
    static void closeEpisodeListMenu(PlayerActivity activity) {
        if (activity.episodeListSheet != null) {
            activity.root.removeView(activity.episodeListSheet);
            activity.episodeListSheet = null;
        }
        if (activity.episodeListScrim != null) {
            activity.root.removeView(activity.episodeListScrim);
            activity.episodeListScrim = null;
            showControlsTemporarily(activity);
        }
    }

    /* Same overlay shape as openEpisodeListMenu above (horizontally-scrolling card row,
       fade-edge scroll arrows, added straight into root for the same edge-to-edge-inset
       reasoning) reused for the More menu's Chapters row instead of an inline picker -
       chapters read better as thumbnail cards than plain text rows, same as episodes
       do. Simpler than the episode overlay in one way: activity.chapters is already
       fully populated (no async Plex fetch like showEpisodeListInternal needs), so
       there's no loading-placeholder state to build and only one call site needs a
       scrim/header pair. */
    static void openChapterListMenu(PlayerActivity activity) {
        float density = activity.getResources().getDisplayMetrics().density;
        closeChapterListMenu(activity);
        closePlayerMenu(activity);
        if (activity.chapters.isEmpty()) return;

        View scrim = new View(activity);
        scrim.setBackgroundColor(Color.TRANSPARENT);
        scrim.setLayoutParams(new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        scrim.setOnClickListener(v -> closeChapterListMenu(activity));

        LinearLayout content = buildEpisodeSheetContainer(activity, density);

        LinearLayout header = new LinearLayout(activity);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        int headerPadH = Math.round(16 * density);
        int headerPadV = Math.round(12 * density);
        header.setPadding(headerPadH, headerPadV, headerPadH, headerPadV);
        TextView heading = new TextView(activity);
        heading.setText("Chapters");
        heading.setTextColor(Color.WHITE);
        heading.setTextSize(16);
        heading.setTypeface(heading.getTypeface(), android.graphics.Typeface.BOLD);
        heading.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        header.addView(heading);
        TextView closeBtn = new TextView(activity);
        closeBtn.setText("✕");
        closeBtn.setTextColor(Color.WHITE);
        closeBtn.setTextSize(16);
        int closePad = Math.round(6 * density);
        closeBtn.setPadding(closePad, closePad, closePad, closePad);
        closeBtn.setOnClickListener(v -> closeChapterListMenu(activity));
        header.addView(closeBtn);
        content.addView(header);

        FrameLayout scrollWrap = new FrameLayout(activity);
        scrollWrap.setLayoutParams(new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        int cardWidthPx = episodeCardWidthPx(activity, density);
        int arrowWidthPx = Math.round(40 * density);

        LinearLayout row = new LinearLayout(activity);
        row.setOrientation(LinearLayout.HORIZONTAL);

        android.widget.HorizontalScrollView scroll = new android.widget.HorizontalScrollView(activity);
        scroll.setHorizontalScrollBarEnabled(false);
        scroll.setLayoutParams(new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT));
        scroll.setClipToPadding(false);
        int scrollPadH = Math.round(6 * density) + arrowWidthPx;
        int scrollPadV = Math.round(12 * density);
        scroll.setPadding(scrollPadH, scrollPadV, scrollPadH, scrollPadV);
        scroll.addView(row, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        /* "Current" is computed once, at open time, from wherever background playback
           happens to be right now - same reasoning chrome.js's own openChapterListOverlay
           gives for not re-deriving this live while the overlay stays open. */
        long positionMs = activity.player != null ? activity.player.getCurrentPosition() : 0;
        View currentCard = null;
        for (int i = 0; i < activity.chapters.size(); i++) {
            ChapterEntry chapter = activity.chapters.get(i);
            ChapterEntry next = i + 1 < activity.chapters.size() ? activity.chapters.get(i + 1) : null;
            boolean isCurrent = chapter.startTimeOffsetMs <= positionMs && (next == null || next.startTimeOffsetMs > positionMs);
            View card = makeChapterCardView(activity, density, chapter, cardWidthPx, isCurrent);
            row.addView(card);
            if (isCurrent) currentCard = card;
        }
        scrollWrap.addView(scroll);

        View leftArrow = makeEpisodeScrollArrow(activity, density, true, scroll, arrowWidthPx);
        View rightArrow = makeEpisodeScrollArrow(activity, density, false, scroll, arrowWidthPx);
        scrollWrap.addView(leftArrow);
        scrollWrap.addView(rightArrow);
        content.addView(scrollWrap);

        Runnable updateArrows = () -> {
            leftArrow.setAlpha(scroll.canScrollHorizontally(-1) ? 1f : 0f);
            leftArrow.setClickable(scroll.canScrollHorizontally(-1));
            rightArrow.setAlpha(scroll.canScrollHorizontally(1) ? 1f : 0f);
            rightArrow.setClickable(scroll.canScrollHorizontally(1));
        };
        scroll.setOnScrollChangeListener((v, x, y, oldX, oldY) -> updateArrows.run());

        View finalCurrentCard = currentCard;
        scroll.post(() -> {
            updateArrows.run();
            if (finalCurrentCard != null) {
                int target = finalCurrentCard.getLeft() - (scroll.getWidth() / 2 - finalCurrentCard.getWidth() / 2);
                scroll.scrollTo(Math.max(0, target), 0);
            }
        });

        activity.root.addView(scrim);
        activity.root.addView(content);
        activity.chapterListScrim = scrim;
        activity.chapterListSheet = content;
        activity.controlsFadeHandler.removeCallbacks(activity.controlsFadeRunnable);
        setControlsVisible(activity, false);
    }

    static void closeChapterListMenu(PlayerActivity activity) {
        if (activity.chapterListSheet != null) {
            activity.root.removeView(activity.chapterListSheet);
            activity.chapterListSheet = null;
        }
        if (activity.chapterListScrim != null) {
            activity.root.removeView(activity.chapterListScrim);
            activity.chapterListScrim = null;
            showControlsTemporarily(activity);
        }
    }

    /* Own standalone dialog for the merged Audio & Subtitles row (see renderMainList) -
       full-height, right-hugging gradient backdrop exactly like showPlayerMenu's own
       More sheet (same menuSheetGradient/CENTER_VERTICAL trick, so the fade reaches
       genuinely top-to-bottom regardless of how short the actual two-column content
       is), just wider (AUDIO_SUBTITLES_WIDTH_DP vs the More sheet's capped 400dp) since
       it needs to fit two side-by-side columns rather than one list of rows. Closes the
       More sheet on the way there, same "own separate overlay" pattern
       openEpisodeListMenu/openChapterListMenu use. */
    private static final int AUDIO_SUBTITLES_WIDTH_DP = 560;

    static void openAudioSubtitlesMenu(PlayerActivity activity) {
        closePlayerMenu(activity);
        closeAudioSubtitlesMenu(activity);
        float density = activity.getResources().getDisplayMetrics().density;

        int screenWidthPx = activity.getResources().getDisplayMetrics().widthPixels;
        int sheetWidthPx = Math.min(Math.round(AUDIO_SUBTITLES_WIDTH_DP * density), Math.round(screenWidthPx * 0.92f));

        View scrim = buildMenuSheetScrim(activity);
        scrim.setOnClickListener(v -> closeAudioSubtitlesMenu(activity));

        LinearLayout sheetContent = buildMenuSheetContainer(activity, sheetWidthPx);
        sheetContent.setGravity(Gravity.CENTER_VERTICAL);

        LinearLayout card = new LinearLayout(activity);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setLayoutParams(new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        int cardPad = Math.round(20 * density);
        card.setPadding(cardPad, Math.round(12 * density), cardPad, cardPad);
        sheetContent.addView(card);

        LinearLayout closeRow = new LinearLayout(activity);
        closeRow.setOrientation(LinearLayout.HORIZONTAL);
        closeRow.setGravity(Gravity.END);
        closeRow.setLayoutParams(new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        TextView closeBtn = new TextView(activity);
        closeBtn.setText("✕");
        closeBtn.setTextColor(Color.WHITE);
        closeBtn.setTextSize(16);
        int closePad = Math.round(6 * density);
        closeBtn.setPadding(closePad, closePad, closePad, closePad);
        closeBtn.setOnClickListener(v -> closeAudioSubtitlesMenu(activity));
        closeRow.addView(closeBtn);
        card.addView(closeRow);

        LinearLayout grid = new LinearLayout(activity);
        grid.setOrientation(LinearLayout.HORIZONTAL);
        grid.setLayoutParams(new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        card.addView(grid);

        LinearLayout audioColumn = buildAudioSubtitlesColumn(activity, density, "Audio");
        LinearLayout.LayoutParams audioColumnParams = (LinearLayout.LayoutParams) audioColumn.getLayoutParams();
        audioColumnParams.setMarginEnd(Math.round(24 * density));
        LinearLayout audioBody = (LinearLayout) audioColumn.getTag();
        if (activity.audioStreams.isEmpty()) {
            TextView noAudio = new TextView(activity);
            noAudio.setText("No alternate audio tracks.");
            noAudio.setTextColor(VALUE_TEXT);
            noAudio.setTextSize(13);
            audioBody.addView(noAudio);
        } else {
            renderAudioSection(activity, audioBody, (v) -> {}, () -> {});
        }
        grid.addView(audioColumn);

        LinearLayout subtitlesColumn = buildAudioSubtitlesColumn(activity, density, "Subtitles");
        renderSubtitlesColumn(activity, density, (LinearLayout) subtitlesColumn.getTag());
        grid.addView(subtitlesColumn);

        activity.root.addView(scrim);
        activity.root.addView(sheetContent);
        activity.audioSubtitlesScrim = scrim;
        activity.audioSubtitlesSheet = sheetContent;
        activity.controlsFadeHandler.removeCallbacks(activity.controlsFadeRunnable);
        setControlsVisible(activity, false);

        /* Caps the WHOLE card, not just each column's own ScrollView - each column
           already shrinks its ScrollView to content or its own near-full-screen cap
           (see buildAudioSubtitlesColumn), but that cap has no idea this method's own
           closeRow/card padding sit above/around both columns too, so the combined
           total can still exceed a landscape screen's actual height even though each
           column's own cap was respected - confirmed against a real device: subtitle
           results were clipped at the screen's bottom edge despite that per-column cap
           already applying correctly. `card` is already attached to activity.root by
           this point (added a few lines up), so card.post() here measures a real
           post-layout height - no pre-attach race like the one buildAudioSubtitlesColumn
           itself used to have. */
        card.post(() -> {
            int screenHeightPx = activity.getResources().getDisplayMetrics().heightPixels;
            int overflowPx = card.getHeight() - Math.round(screenHeightPx * 0.94f);
            if (overflowPx <= 0) return;
            for (LinearLayout column : new LinearLayout[] { audioColumn, subtitlesColumn }) {
                View scroll = column.getChildAt(column.getChildCount() - 1);
                if (!(scroll instanceof ScrollView)) continue;
                ViewGroup.LayoutParams params = scroll.getLayoutParams();
                params.height = Math.max(0, scroll.getHeight() - overflowPx);
                scroll.setLayoutParams(params);
            }
        });
    }

    static void closeAudioSubtitlesMenu(PlayerActivity activity) {
        if (activity.audioSubtitlesSheet != null) {
            activity.root.removeView(activity.audioSubtitlesSheet);
            activity.audioSubtitlesSheet = null;
        }
        if (activity.audioSubtitlesScrim != null) {
            activity.root.removeView(activity.audioSubtitlesScrim);
            activity.audioSubtitlesScrim = null;
            showControlsTemporarily(activity);
        }
    }

    /* Rebuilds the whole dialog in place whenever its underlying data changes
       (a subtitle search resolving, an apply succeeding/failing, the Off row clearing
       the track) - simpler than threading a mutable TextView reference through the
       native<->JS round trip to patch one row in place, at the cost of a visible full
       redraw on each of those (infrequent, user-initiated) events. No-op if the dialog
       isn't currently open. */
    static void refreshAudioSubtitlesMenu(PlayerActivity activity) {
        if (activity.audioSubtitlesSheet == null) return;
        openAudioSubtitlesMenu(activity);
    }

    /* One column of the grid above - a bold heading with a divider underneath (matching
       the HBO Max reference the web leg's own openAudioSubtitlesOverlay was built
       against) plus a `body` LinearLayout inside a capped-height ScrollView the caller
       renders its own picker list into. The returned column View carries `body` as its
       tag rather than this method returning a pair, since every other builder in this
       file already returns a single View. */
    private static LinearLayout buildAudioSubtitlesColumn(PlayerActivity activity, float density, String title) {
        LinearLayout column = new LinearLayout(activity);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        TextView heading = new TextView(activity);
        heading.setText(title);
        heading.setTextColor(Color.WHITE);
        heading.setTextSize(15);
        heading.setTypeface(heading.getTypeface(), android.graphics.Typeface.BOLD);
        heading.setPadding(0, 0, 0, Math.round(10 * density));
        column.addView(heading);

        View divider = new View(activity);
        divider.setBackgroundColor(Color.argb(64, 255, 255, 255));
        column.addView(divider, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, Math.round(1 * density)));

        LinearLayout body = new LinearLayout(activity);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(0, Math.round(16 * density), 0, 0);

        /* A flat 40% of screen height used to cap this well short of what's actually
           available (mirrors the same fix on the web leg's own buildAudioSubtitlesColumn
           in chrome.js) - ~140dp covers this method's own card padding, closeRow, this
           column's heading/divider, and body's own top padding, so the cap now
           represents genuinely close to the full screen instead of an arbitrary 40%
           slice of it. Short lists (Audio, most Subtitle searches) still shrink to their
           own content (see the MeasureSpec override below) - this only changes the
           ceiling for a long list that actually wants more room, which is exactly the
           mobile case that felt cramped. The card.post() block below (94%-of-screen
           safety net on the combined card) still exists for the same reason it always
           did - it clamps the *total* sheet to the physical screen in landscape/short
           viewports, independent of and unaffected by this per-column cap. */
        int fixedChromePx = Math.round(140 * density);
        int maxHeightPx = Math.max(0, activity.getResources().getDisplayMetrics().heightPixels - fixedChromePx);
        /* Capped via an onMeasure override (AT_MOST against maxHeightPx) rather than the
           previous post()-then-check-body.getHeight() approach - that read the body's
           height before this column's very first layout pass had run (scroll.post() is
           queued here while `scroll` is still unattached to any window; Android flushes
           an unattached view's queued post() actions during attach, which happens before
           that same traversal's measure/layout), so body.getHeight() was reliably still 0
           and the cap never actually applied. That looked exactly like "the subtitle
           results scroll area renders tiny" on a real device - the ScrollView was left
           at plain WRAP_CONTENT with no cap, so only whatever leftover space existed
           after the rest of the sheet was visible, and dragging it still scrolled
           (confirmed against a real device: the fix removes the need to drag at all). A
           MeasureSpec override has no such race - it's re-evaluated on every measure
           pass, including every refreshAudioSubtitlesMenu rebuild, and still shrinks to
           content instead of always reserving the full cap for a short list (e.g. only
           two audio tracks), matching clampMenuCardHeight's own "shrink to content, then
           cap" behavior for the More sheet's card. */
        ScrollView scroll = new ScrollView(activity) {
            @Override
            protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
                int cappedHeightSpec = View.MeasureSpec.makeMeasureSpec(maxHeightPx, View.MeasureSpec.AT_MOST);
                super.onMeasure(widthMeasureSpec, cappedHeightSpec);
            }
        };
        scroll.setVerticalScrollBarEnabled(false);
        scroll.addView(body, new ScrollView.LayoutParams(ScrollView.LayoutParams.MATCH_PARENT, ScrollView.LayoutParams.WRAP_CONTENT));
        scroll.setLayoutParams(new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        column.addView(scroll);

        column.setTag(body);
        return column;
    }

    /* Audio column content - reuses renderAudioSection wholesale (same picker-row
       list/checkmark logic the old standalone accordion row used) with no-op setValue/
       collapse, exactly mirroring how chrome.js's own openAudioSubtitlesOverlay reuses
       renderAudioSection on the web leg instead of a second, parallel implementation. */

    /* Real-world .srt files are commonly a fixed amount early/late against the actual
       video - mirrors chrome.js's own SUBTITLE_OFFSET_STEP_MS/adjustSubtitleOffset on
       the web leg exactly (same 250ms step), just calling activity.adjustSubtitleOffset
       directly instead of mutating a TextTrack's cues, since this leg has no equivalent
       live cue list to mutate (see that method's own header comment). */
    private static final long SUBTITLE_OFFSET_STEP_MS = 250L;

    private static View buildSubtitleOffsetRow(PlayerActivity activity, float density) {
        LinearLayout row = new LinearLayout(activity);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        rowParams.bottomMargin = Math.round(10 * density);
        row.setLayoutParams(rowParams);

        TextView label = new TextView(activity);
        label.setText("Sync: " + formatSubtitleOffset(activity.subtitleOffsetMs()));
        label.setTextColor(VALUE_TEXT);
        label.setTextSize(13);
        label.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        row.addView(label);

        row.addView(buildSubtitleOffsetStepBtn(activity, density, "–", -SUBTITLE_OFFSET_STEP_MS));
        View spacer = new View(activity);
        spacer.setLayoutParams(new LinearLayout.LayoutParams(Math.round(6 * density), 1));
        row.addView(spacer);
        row.addView(buildSubtitleOffsetStepBtn(activity, density, "+", SUBTITLE_OFFSET_STEP_MS));

        return row;
    }

    /* No local label update on click, unlike a plain picker row's own state - clicking
       calls into activity.adjustSubtitleOffset, which already ends in
       PlayerUiHelper.refreshAudioSubtitlesMenu (a full rebuild of this whole dialog), so
       this row's own label gets its updated text for free on the very next render. */
    private static TextView buildSubtitleOffsetStepBtn(PlayerActivity activity, float density, String glyph, long deltaMs) {
        TextView btn = new TextView(activity);
        btn.setText(glyph);
        btn.setTextColor(Color.WHITE);
        btn.setTextSize(16);
        btn.setTypeface(btn.getTypeface(), android.graphics.Typeface.BOLD);
        btn.setGravity(Gravity.CENTER);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.argb(20, 255, 255, 255));
        bg.setStroke(1, Color.argb(51, 255, 255, 255));
        bg.setCornerRadius(6 * density);
        btn.setBackground(bg);
        int sizePx = Math.round(30 * density);
        btn.setLayoutParams(new LinearLayout.LayoutParams(sizePx, sizePx));
        btn.setOnClickListener(v -> activity.adjustSubtitleOffset(deltaMs));
        return btn;
    }

    private static String formatSubtitleOffset(long ms) {
        return (ms > 0 ? "+" : "") + ms + "ms";
    }

    /* Matches chrome.js's buildSubtitleOffButton - a standalone bordered button next to
       the Sync row, not a "checked" row mixed in with search results, since unlike a
       real result "Off" isn't a choice you search for. Only shown once a subtitle is
       actually attached (see renderSubtitlesColumn's caller), same condition as the
       Sync row above it - there's nothing to turn off otherwise. */
    private static TextView buildSubtitleOffButton(PlayerActivity activity, float density) {
        TextView btn = new TextView(activity);
        btn.setText("Off");
        btn.setTextColor(Color.WHITE);
        btn.setTextSize(13);
        btn.setTypeface(btn.getTypeface(), android.graphics.Typeface.BOLD);
        btn.setGravity(Gravity.CENTER);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.argb(20, 255, 255, 255));
        bg.setStroke(1, Color.argb(51, 255, 255, 255));
        bg.setCornerRadius(8 * density);
        btn.setBackground(bg);
        int padV = Math.round(9 * density);
        btn.setPadding(0, padV, 0, padV);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.bottomMargin = Math.round(10 * density);
        btn.setLayoutParams(params);
        btn.setOnClickListener(v -> activity.clearSubtitleTrack());
        return btn;
    }

    /* Subtitles column content - search box (defaults to this title, matching
       chrome.js's renderSubtitleSection) plus an "Off" row and whatever
       activity.subtitleResults holds. Fully re-derived from activity's own fields each
       call (see refreshAudioSubtitlesMenu) rather than mutated in place. */
    private static void renderSubtitlesColumn(PlayerActivity activity, float density, LinearLayout body) {
        EditText input = new EditText(activity);
        input.setHint("Search subtitles…");
        input.setHintTextColor(VALUE_TEXT);
        input.setTextColor(Color.WHITE);
        input.setTextSize(13);
        input.setSingleLine(true);
        String defaultQuery = activity.title != null ? activity.title : "";
        input.setText(activity.subtitleSearchQueryText != null ? activity.subtitleSearchQueryText : defaultQuery);
        GradientDrawable inputBg = new GradientDrawable();
        inputBg.setColor(Color.argb(15, 255, 255, 255));
        inputBg.setStroke(1, Color.argb(38, 255, 255, 255));
        inputBg.setCornerRadius(8 * density);
        input.setBackground(inputBg);
        int inputPadH = Math.round(12 * density);
        int inputPadV = Math.round(9 * density);
        input.setPadding(inputPadH, inputPadV, inputPadH, inputPadV);
        LinearLayout.LayoutParams inputParams = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        inputParams.bottomMargin = Math.round(8 * density);
        input.setLayoutParams(inputParams);
        body.addView(input);

        TextView searchBtn = new TextView(activity);
        searchBtn.setText("Search");
        searchBtn.setTextColor(Color.parseColor("#1A1A1A"));
        searchBtn.setTextSize(13);
        searchBtn.setTypeface(searchBtn.getTypeface(), android.graphics.Typeface.BOLD);
        searchBtn.setGravity(Gravity.CENTER);
        GradientDrawable searchBg = new GradientDrawable();
        searchBg.setColor(ACCENT_COLOR);
        searchBg.setCornerRadius(8 * density);
        searchBtn.setBackground(searchBg);
        int searchPad = Math.round(9 * density);
        searchBtn.setPadding(searchPad, searchPad, searchPad, searchPad);
        LinearLayout.LayoutParams searchParams = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        searchParams.bottomMargin = Math.round(10 * density);
        searchBtn.setLayoutParams(searchParams);
        searchBtn.setOnClickListener(v -> {
            activity.subtitleSearchQueryText = input.getText().toString();
            activity.subtitleSearchStatus = "searching";
            activity.subtitleResults.clear();
            PlayerUiHelper.refreshAudioSubtitlesMenu(activity);
            PlayerActivity.requestSubtitleSearch(activity.subtitleSearchQueryText);
        });
        body.addView(searchBtn);

        /* Matches chrome.js's renderSubtitleSection ("if (input.value) runSearch()") -
           auto-runs a default search (this title) the first time this column renders
           for the session, so a search result is already there to check against
           currentSubtitleFileId instead of requiring an explicit "Search" tap first.
           Guarded on subtitleSearchQueryText/subtitleSearchStatus still being at their
           session-start "idle" defaults (see applyTitleSwitch) rather than a separate
           one-shot flag - that's the same state a completed or in-flight search already
           moves away from, so this can't re-trigger on every refreshAudioSubtitlesMenu
           rebuild once the real search is underway or done. Status is set to
           "searching" before the picker rows/status text below get built, so this same
           render already shows "Searching..." without a nested refresh call. */
        if (activity.subtitleSearchQueryText == null && "idle".equals(activity.subtitleSearchStatus)
                && !defaultQuery.isEmpty()) {
            activity.subtitleSearchQueryText = defaultQuery;
            activity.subtitleSearchStatus = "searching";
            PlayerActivity.requestSubtitleSearch(defaultQuery);
        }

        /* Only shown once a subtitle is actually attached - offsetting/removing a track
           that doesn't exist yet has nothing to act on, same condition chrome.js's own
           renderSubtitleSection uses on the web leg. Rebuilt fresh on every render (this
           whole method already fully re-derives body's content each call) rather than
           kept in sync some other way. */
        if (activity.currentSubtitleFileId != null) {
            body.addView(buildSubtitleOffsetRow(activity, density));
            body.addView(buildSubtitleOffButton(activity, density));
        }

        List<PickerItem> items = new ArrayList<>();
        for (SubtitleResultEntry entry : activity.subtitleResults) {
            boolean isCurrent = entry.fileId.equals(activity.currentSubtitleFileId);
            boolean isPending = entry.fileId.equals(activity.subtitlePendingFileId);
            boolean isError = entry.fileId.equals(activity.subtitleApplyErrorFileId);
            String label = entry.label + " (" + entry.languageCode + ")";
            if (isPending) {
                label = "Applying…";
            } else if (isError) {
                label = label + " — failed: " + activity.subtitleApplyErrorMessage;
            } else if (isCurrent) {
                label = label + "  ✓";
            }
            String finalLabel = label;
            items.add(new PickerItem(finalLabel, () -> {
                activity.subtitlePendingFileId = entry.fileId;
                activity.subtitleApplyErrorFileId = null;
                PlayerUiHelper.refreshAudioSubtitlesMenu(activity);
                PlayerActivity.requestSubtitleSelect(entry.fileId, entry.label, entry.languageCode);
            }));
        }
        renderPickerRows(activity, body, density, items);

        if ("searching".equals(activity.subtitleSearchStatus)) {
            TextView status = new TextView(activity);
            status.setText("Searching…");
            status.setTextColor(VALUE_TEXT);
            status.setTextSize(13);
            body.addView(status);
        } else if ("error".equals(activity.subtitleSearchStatus)) {
            TextView status = new TextView(activity);
            status.setText(activity.subtitleSearchError != null ? activity.subtitleSearchError : "Search failed.");
            status.setTextColor(VALUE_TEXT);
            status.setTextSize(13);
            body.addView(status);
        } else if ("done".equals(activity.subtitleSearchStatus) && activity.subtitleResults.isEmpty()) {
            TextView status = new TextView(activity);
            status.setText("No results.");
            status.setTextColor(VALUE_TEXT);
            status.setTextSize(13);
            body.addView(status);
        }
    }

    /* One card of the chapter row above - deliberately much plainer than
       makeEpisodeCardView (no watched badge, no progress bar, no summary line): a
       chapter is a timestamp within the title already being watched, not a separate
       Plex item with its own watched/progress state of its own. */
    private static View makeChapterCardView(PlayerActivity activity, float density, ChapterEntry chapter, int cardWidthPx, boolean isCurrent) {
        LinearLayout card = new LinearLayout(activity);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackground(rowPressBackground());
        int cardPad = Math.round(4 * density);
        card.setPadding(cardPad, cardPad, cardPad, cardPad);
        LinearLayout.LayoutParams cardParams = new LinearLayout.LayoutParams(cardWidthPx, LinearLayout.LayoutParams.WRAP_CONTENT);
        cardParams.setMarginEnd(Math.round(14 * density));
        card.setLayoutParams(cardParams);

        FrameLayout thumbFrame = new FrameLayout(activity);
        int thumbWidthPx = cardWidthPx - cardPad * 2;
        int thumbHeightPx = Math.round(thumbWidthPx * 9f / 16f);
        LinearLayout.LayoutParams thumbFrameParams = new LinearLayout.LayoutParams(thumbWidthPx, thumbHeightPx);
        thumbFrameParams.bottomMargin = Math.round(6 * density);
        thumbFrame.setLayoutParams(thumbFrameParams);

        android.widget.ImageView thumb = new android.widget.ImageView(activity);
        thumb.setLayoutParams(new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        thumb.setScaleType(android.widget.ImageView.ScaleType.CENTER_CROP);
        GradientDrawable thumbBg = new GradientDrawable();
        thumbBg.setColor(Color.argb(20, 255, 255, 255));
        thumbBg.setCornerRadius(6f * density);
        if (isCurrent) {
            thumbBg.setStroke(Math.round(2 * density), ACCENT_COLOR);
        }
        thumb.setBackground(thumbBg);
        thumb.setClipToOutline(true);
        thumbFrame.addView(thumb);
        if (chapter.thumbUrl != null) {
            String thumbUrl = chapter.thumbUrl;
            PlexHttp.runAsync(() -> PlexHttp.fetchBitmapSync(thumbUrl), bitmap -> {
                if (bitmap != null) thumb.setImageBitmap(bitmap);
            });
        }
        card.addView(thumbFrame);

        String time = formatTimestamp(chapter.startTimeOffsetMs);
        TextView title = new TextView(activity);
        title.setText(chapter.title == null || chapter.title.isEmpty() ? time : chapter.title);
        title.setTextColor(Color.WHITE);
        title.setTextSize(13);
        title.setTypeface(title.getTypeface(), android.graphics.Typeface.BOLD);
        title.setMaxLines(1);
        title.setEllipsize(TextUtils.TruncateAt.END);
        card.addView(title);

        if (chapter.title != null && !chapter.title.isEmpty()) {
            TextView subtitle = new TextView(activity);
            subtitle.setText(time);
            subtitle.setTextColor(VALUE_TEXT);
            subtitle.setTextSize(10);
            LinearLayout.LayoutParams subtitleParams =
                new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            subtitleParams.topMargin = Math.round(2 * density);
            subtitle.setLayoutParams(subtitleParams);
            card.addView(subtitle);
        }

        card.setOnClickListener(v -> {
            closeChapterListMenu(activity);
            PlayerActivity.seek(chapter.startTimeOffsetMs);
        });
        return card;
    }

    /* Same fade-upward-into-the-video scrim as episode-list.js's own panel background
       ("linear-gradient(to top, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.88) 55%, rgba(0,0,0,0.5)
       85%, transparent 100%)") - GradientDrawable's plain color-array constructor only
       supports evenly-spaced stops (no arbitrary percentages like the CSS version), same
       approximation buildTransportBar's own 3-stop gradient already makes for its
       equivalent fade, so this follows that same established precedent rather than
       reaching for a custom Shader just for closer-to-exact stop positions. */
    private static Drawable episodeSheetGradient() {
        return new GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, new int[]{
            Color.argb(235, 0, 0, 0),
            Color.argb(224, 0, 0, 0),
            Color.argb(128, 0, 0, 0),
            Color.argb(0, 0, 0, 0),
        });
    }

    /* Same "Scroll left"/"Scroll right" fade-edge idea as episode-list.js's
       buildQueueScrollArrow - a gradient-scrim chevron button anchored to one edge of the
       scroll area, faded in/out based on scroll position rather than always visible. */
    private static View makeEpisodeScrollArrow(PlayerActivity activity, float density, boolean left, android.widget.HorizontalScrollView scroll, int widthPx) {
        TextView btn = new TextView(activity);
        btn.setText(left ? "‹" : "›");
        btn.setTextColor(Color.WHITE);
        btn.setTextSize(22);
        btn.setGravity(Gravity.CENTER);
        btn.setAlpha(0f);
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(widthPx, FrameLayout.LayoutParams.MATCH_PARENT);
        params.gravity = (left ? Gravity.START : Gravity.END) | Gravity.CENTER_VERTICAL;
        btn.setLayoutParams(params);
        GradientDrawable bg = new GradientDrawable(
            left ? GradientDrawable.Orientation.LEFT_RIGHT : GradientDrawable.Orientation.RIGHT_LEFT,
            new int[]{Color.argb(230, 10, 10, 12), Color.argb(0, 10, 10, 12)});
        btn.setBackground(bg);
        btn.setOnClickListener(v -> scroll.smoothScrollBy(Math.round(scroll.getWidth() * 0.9f) * (left ? -1 : 1), 0));
        return btn;
    }

    /* One card of the episode row above - a thumbnail (with a watched badge or progress
       bar overlaid, mutually exclusive) above a title/subtitle/summary text stack, both
       matching episode-list.js's buildEpisodeCard exactly (same fields, same mutual-
       exclusivity, same amber current-item border). */
    private static View makeEpisodeCardView(PlayerActivity activity, float density, EpisodeEntry item, int cardWidthPx) {
        LinearLayout card = new LinearLayout(activity);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackground(rowPressBackground());
        int cardPad = Math.round(4 * density);
        card.setPadding(cardPad, cardPad, cardPad, cardPad);
        LinearLayout.LayoutParams cardParams = new LinearLayout.LayoutParams(cardWidthPx, LinearLayout.LayoutParams.WRAP_CONTENT);
        cardParams.setMarginEnd(Math.round(14 * density));
        card.setLayoutParams(cardParams);

        FrameLayout thumbFrame = new FrameLayout(activity);
        int thumbWidthPx = cardWidthPx - cardPad * 2;
        int thumbHeightPx = Math.round(thumbWidthPx * 9f / 16f);
        LinearLayout.LayoutParams thumbFrameParams = new LinearLayout.LayoutParams(thumbWidthPx, thumbHeightPx);
        thumbFrameParams.bottomMargin = Math.round(6 * density);
        thumbFrame.setLayoutParams(thumbFrameParams);

        android.widget.ImageView thumb = new android.widget.ImageView(activity);
        thumb.setLayoutParams(new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        thumb.setScaleType(android.widget.ImageView.ScaleType.CENTER_CROP);
        GradientDrawable thumbBg = new GradientDrawable();
        thumbBg.setColor(Color.argb(20, 255, 255, 255));
        thumbBg.setCornerRadius(6f * density);
        if (item.current) {
            thumbBg.setStroke(Math.round(2 * density), ACCENT_COLOR);
        }
        thumb.setBackground(thumbBg);
        thumb.setClipToOutline(true);
        thumbFrame.addView(thumb);
        if (item.thumbUrl != null) {
            String thumbUrl = item.thumbUrl;
            PlexHttp.runAsync(() -> PlexHttp.fetchBitmapSync(thumbUrl), bitmap -> {
                if (bitmap != null) thumb.setImageBitmap(bitmap);
            });
        }

        /* Same dark-circle/amber-checkmark badge vs. amber progress-bar-along-the-bottom-
           edge, mutually exclusive, as episode-list.js's buildEpisodeCard. */
        if (item.watched) {
            TextView badge = new TextView(activity);
            badge.setText("✓");
            badge.setTextColor(ACCENT_COLOR);
            badge.setTextSize(10);
            badge.setGravity(Gravity.CENTER);
            int badgeSizePx = Math.round(18 * density);
            FrameLayout.LayoutParams badgeParams = new FrameLayout.LayoutParams(badgeSizePx, badgeSizePx);
            badgeParams.gravity = Gravity.TOP | Gravity.START;
            badgeParams.setMargins(Math.round(4 * density), Math.round(4 * density), 0, 0);
            badge.setLayoutParams(badgeParams);
            GradientDrawable badgeBg = new GradientDrawable();
            badgeBg.setShape(GradientDrawable.OVAL);
            badgeBg.setColor(Color.argb(179, 20, 20, 24));
            badge.setBackground(badgeBg);
            thumbFrame.addView(badge);
        } else if (item.progress > 0) {
            View track = new View(activity);
            track.setBackgroundColor(Color.argb(77, 255, 255, 255));
            int trackHeightPx = Math.round(3 * density);
            FrameLayout.LayoutParams trackParams = new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, trackHeightPx);
            trackParams.gravity = Gravity.BOTTOM;
            track.setLayoutParams(trackParams);
            thumbFrame.addView(track);

            View bar = new View(activity);
            bar.setBackgroundColor(ACCENT_COLOR);
            int barWidthPx = Math.round(thumbWidthPx * Math.max(0f, Math.min(1f, item.progress)));
            FrameLayout.LayoutParams barParams = new FrameLayout.LayoutParams(barWidthPx, trackHeightPx);
            barParams.gravity = Gravity.BOTTOM | Gravity.START;
            bar.setLayoutParams(barParams);
            thumbFrame.addView(bar);
        }

        card.addView(thumbFrame);

        TextView title = new TextView(activity);
        title.setText(item.title);
        title.setTextColor(Color.WHITE);
        title.setTextSize(13);
        title.setTypeface(title.getTypeface(), android.graphics.Typeface.BOLD);
        title.setMaxLines(1);
        title.setEllipsize(TextUtils.TruncateAt.END);
        card.addView(title);

        if (item.subtitle != null && !item.subtitle.isEmpty()) {
            TextView subtitle = new TextView(activity);
            subtitle.setText(item.subtitle);
            subtitle.setTextColor(VALUE_TEXT);
            subtitle.setTextSize(10);
            LinearLayout.LayoutParams subtitleParams =
                new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            subtitleParams.topMargin = Math.round(2 * density);
            subtitle.setLayoutParams(subtitleParams);
            card.addView(subtitle);
        }

        if (item.summary != null && !item.summary.isEmpty()) {
            TextView summary = new TextView(activity);
            summary.setText(item.summary);
            summary.setTextColor(SUBTLE_TEXT);
            summary.setTextSize(10);
            summary.setMaxLines(3);
            summary.setEllipsize(TextUtils.TruncateAt.END);
            LinearLayout.LayoutParams summaryParams =
                new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            summaryParams.topMargin = Math.round(4 * density);
            summary.setLayoutParams(summaryParams);
            card.addView(summary);
        }

        /* Reuses the exact same round trip title-prev/title-next already use
           (PlayerActivity.requestTitleNav -> JS's "titleNav" listener ->
           chrome.js's playQueuedTitle) rather than a new event type - that function
           already accepts an arbitrary queue index, not just the adjacent one. Tapping
           the current episode just dismisses, matching episode-list.js's own onSelect. */
        card.setOnClickListener(v -> {
            closeEpisodeListMenu(activity);
            if (!item.current) {
                PlayerActivity.requestTitleNav(item.queueIndex);
            }
        });

        return card;
    }

    private static Drawable rowPressBackground() {
        StateListDrawable states = new StateListDrawable();
        states.addState(new int[]{android.R.attr.state_pressed}, new ColorDrawable(ROW_PRESSED_BG));
        states.addState(new int[]{}, new ColorDrawable(Color.TRANSPARENT));
        return states;
    }

    private static ColorStateList toggleTrackTint() {
        return new ColorStateList(
            new int[][]{new int[]{android.R.attr.state_checked}, new int[]{}},
            new int[]{ACCENT_COLOR, Color.argb(64, 255, 255, 255)});
    }

    private static ColorStateList toggleThumbTint() {
        return new ColorStateList(
            new int[][]{new int[]{android.R.attr.state_checked}, new int[]{}},
            new int[]{ACCENT_COLOR, Color.WHITE});
    }

    static String formatTimestamp(long ms) {
        long totalSeconds = ms / 1000;
        long h = totalSeconds / 3600;
        long m = (totalSeconds % 3600) / 60;
        long s = totalSeconds % 60;
        return h > 0 ? String.format("%d:%02d:%02d", h, m, s) : String.format("%d:%02d", m, s);
    }

    /* Lazily created on first marker hit, then just shown/hidden - kept out of
       fadingControls deliberately: it's a contextual action available right now, not
       ambient chrome that should fade on idle, so it doesn't join that shared loop. */
    static void updateSkipButton(PlayerActivity activity, String label, long seekToMs) {
        activity.skipButtonSeekToMs = seekToMs;
        if (activity.skipButton == null) {
            float density = activity.getResources().getDisplayMetrics().density;
            activity.skipButton = new TextView(activity);
            activity.skipButton.setTextColor(Color.WHITE);
            activity.skipButton.setTextSize(14);
            activity.skipButton.setTypeface(activity.skipButton.getTypeface(), android.graphics.Typeface.BOLD);
            activity.skipButton.setBackgroundColor(Color.parseColor("#D9141414"));
            int hPad = (int) (20 * density);
            int vPad = (int) (10 * density);
            activity.skipButton.setPadding(hPad, vPad, hPad, vPad);
            FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT);
            params.gravity = Gravity.BOTTOM | Gravity.END;
            /* Clears the taller transport bar this redesign introduced (title/subtitle
               header row + seek bar + controls row, vs. the old flat mute-only row). */
            params.setMargins(0, 0, (int) (40 * density), (int) (200 * density));
            activity.skipButton.setLayoutParams(params);
            activity.skipButton.setOnClickListener(v -> PlayerActivity.seek(activity.skipButtonSeekToMs));
            activity.root.addView(activity.skipButton);
        }
        activity.skipButton.setText(label);
        activity.skipButton.setVisibility(View.VISIBLE);
    }

    static void hideSkipButtonInternal(PlayerActivity activity) {
        if (activity.skipButton != null) {
            activity.skipButton.setVisibility(View.GONE);
        }
    }

    static void applyZoomTransform(PlayerActivity activity, View v) {
        v.setScaleX(activity.zoomScale);
        v.setScaleY(activity.zoomScale);
        v.setTranslationX(activity.panX);
        v.setTranslationY(activity.panY);
    }

    static float clamp(float value, float min, float max) {
        return Math.max(min, Math.min(max, value));
    }

    static void updateTransportUi(PlayerActivity activity, long positionMs, long durationMs) {
        /* Skipped entirely while scrubbing, same as before - during a drag, onProgressChanged
           (see buildTransportBar) already keeps transportSeekBar/timeRemainingText/
           segmentedTrack synced to the live drag position, not the stale last-reported
           real playback position this ~1s tick would otherwise fight it with. */
        if (activity.transportSeekBar == null || activity.seekBarScrubbing) return;
        if (durationMs > 0) {
            activity.transportSeekBar.setProgress((int) ((positionMs * 1000) / durationMs));
            if (activity.timeRemainingText != null) {
                activity.timeRemainingText.setText("-" + formatTimestamp(Math.max(0, durationMs - positionMs)));
            }
            if (activity.segmentedTrack != null && activity.player != null) {
                activity.segmentedTrack.setChapters(activity.chapters, durationMs);
                activity.segmentedTrack.setProgress(positionMs, activity.player.getBufferedPosition(), durationMs);
            }
        }
    }

    private static void syncSegmentedTrack(PlayerActivity activity, long positionMs) {
        if (activity.segmentedTrack == null || activity.player == null) return;
        long duration = activity.player.getDuration();
        if (duration == androidx.media3.common.C.TIME_UNSET || duration <= 0) return;
        activity.segmentedTrack.setChapters(activity.chapters, duration);
        activity.segmentedTrack.setProgress(positionMs, activity.player.getBufferedPosition(), duration);
    }

    /* Built lazily on first use rather than in buildTransportBar - most playback
       sessions with no BIF data (or where the user never drags) never need it at all. */
    private static void ensureScrubPreviewPopup(PlayerActivity activity, float density) {
        if (activity.scrubPreviewPopup != null) return;

        LinearLayout content = new LinearLayout(activity);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setGravity(Gravity.CENTER_HORIZONTAL);

        android.widget.ImageView image = new android.widget.ImageView(activity);
        LinearLayout.LayoutParams imageParams =
            new LinearLayout.LayoutParams(Math.round(160 * density), Math.round(90 * density));
        image.setLayoutParams(imageParams);
        image.setScaleType(android.widget.ImageView.ScaleType.CENTER_CROP);
        GradientDrawable imageBg = new GradientDrawable();
        imageBg.setColor(Color.BLACK);
        imageBg.setCornerRadius(6f * density);
        image.setBackground(imageBg);
        image.setClipToOutline(true);
        content.addView(image);
        activity.scrubPreviewImageView = image;

        TextView time = new TextView(activity);
        time.setTextColor(Color.WHITE);
        time.setTextSize(12);
        int timePadH = Math.round(8 * density);
        int timePadV = Math.round(3 * density);
        time.setPadding(timePadH, timePadV, timePadH, timePadV);
        GradientDrawable timeBg = new GradientDrawable();
        timeBg.setColor(Color.argb(191, 0, 0, 0));
        timeBg.setCornerRadius(4f * density);
        time.setBackground(timeBg);
        LinearLayout.LayoutParams timeParams =
            new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        timeParams.topMargin = Math.round(6 * density);
        time.setLayoutParams(timeParams);
        content.addView(time);
        activity.scrubPreviewTimeView = time;

        PopupWindow popup = new PopupWindow(content, ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        popup.setTouchable(false);
        popup.setOutsideTouchable(false);
        popup.setBackgroundDrawable(null);
        activity.scrubPreviewPopup = popup;
    }

    /* Time label always shown immediately; the image fills in once (a) a BIF index
       exists for this session at all - most don't have one generated - and (b) the
       frame nearest this position has been fetched, same "never worse than no preview"
       fallback the web leg's tooltip uses. Frame fetches are debounced to roughly one
       per real second of video scrubbed past, not one per onProgressChanged call - a
       fast drag across a long movie can fire many of those a second. */
    private static void showScrubPreview(PlayerActivity activity, SeekBar seekBar, int progress, long duration, float density) {
        ensureScrubPreviewPopup(activity, density);
        long timeMs = progress * duration / 1000;
        activity.scrubPreviewTimeView.setText(formatTimestamp(timeMs));

        View content = activity.scrubPreviewPopup.getContentView();
        content.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED);
        int measuredWidth = content.getMeasuredWidth();
        int measuredHeight = content.getMeasuredHeight();

        int[] loc = new int[2];
        seekBar.getLocationOnScreen(loc);
        float fraction = progress / 1000f;
        int x = loc[0] + Math.round(fraction * seekBar.getWidth()) - measuredWidth / 2;
        x = Math.max(loc[0], Math.min(loc[0] + seekBar.getWidth() - measuredWidth, x));
        int y = loc[1] - measuredHeight - Math.round(10 * density);

        if (!activity.scrubPreviewPopup.isShowing()) {
            activity.scrubPreviewPopup.showAtLocation(seekBar, Gravity.NO_GRAVITY, x, y);
        } else {
            activity.scrubPreviewPopup.update(x, y, measuredWidth, measuredHeight);
        }

        if (activity.bifIndex == null) return;
        if (activity.scrubPreviewLastTimeMs >= 0 && Math.abs(timeMs - activity.scrubPreviewLastTimeMs) < 1000) return;
        activity.scrubPreviewLastTimeMs = timeMs;
        BifIndex.Frame frame = activity.bifIndex.findNearestFrame(timeMs);
        if (frame == null) return;
        int requestId = ++activity.scrubPreviewRequestId;
        activity.bifIndex.fetchFrameBitmap(frame, bitmap -> {
            // A newer drag position may have won the race, or the drag may have ended.
            if (requestId != activity.scrubPreviewRequestId || bitmap == null) return;
            if (activity.scrubPreviewImageView != null) activity.scrubPreviewImageView.setImageBitmap(bitmap);
        });
    }

    private static void hideScrubPreview(PlayerActivity activity) {
        if (activity.scrubPreviewPopup != null && activity.scrubPreviewPopup.isShowing()) {
            activity.scrubPreviewPopup.dismiss();
        }
        activity.scrubPreviewLastTimeMs = -1L;
    }
}
