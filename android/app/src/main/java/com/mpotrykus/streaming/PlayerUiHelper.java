package com.mpotrykus.streaming;

import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.PorterDuff;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.text.TextUtils;
import android.view.GestureDetector;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
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

/* Transport-bar/menu/chapter-skip chrome for PlayerActivity, pulled out into its own
   class the same way plex-player.js's web-side transport bar/menus live in
   src/player/ui/chrome.js rather than on the playback controller itself. Every method
   here takes the PlayerActivity instance as an explicit first argument and reads/writes
   its fields directly (those fields are package-private, not private, for exactly this
   reason) rather than through a narrower interface - same "one playback session's
   shared state, not a separable subsystem" reasoning the JS-side split uses.

   Visual language mirrors chrome.js's redesign directly: the amber accent color, the
   gradient transport bar with a title/remaining-time header, and glass-panel PopupWindow
   flyouts standing in for chrome.js's div-based menu panels (openHamburgerMenu/
   openInlineMenu) instead of a native PopupMenu/AlertDialog. */
@OptIn(markerClass = UnstableApi.class)
final class PlayerUiHelper {
    private PlayerUiHelper() {}

    private static final int ACCENT_COLOR = Color.parseColor("#E5A00D");
    private static final int PANEL_BG = Color.argb(240, 24, 24, 26);
    private static final int PANEL_BORDER = Color.argb(20, 255, 255, 255);
    private static final int ROW_PRESSED_BG = Color.argb(26, 255, 255, 255);
    private static final int DIM_TEXT = Color.argb(166, 255, 255, 255);
    private static final int SUBTLE_TEXT = Color.argb(140, 255, 255, 255);
    private static final int VALUE_TEXT = Color.argb(102, 255, 255, 255);
    private static final int REMAINING_TEXT = Color.argb(191, 255, 255, 255);

    private static final float[] PLAYBACK_RATES = {0.25f, 0.5f, 0.75f, 1f, 1.25f, 1.5f, 2f, 4f, 8f};
    private static final int[] SLEEP_TIMER_PRESETS_MIN = {15, 30, 45, 60};
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

    /* Touch-only affordance - only ever built when activity.hasTouchscreen (see the
       onCreate call site), since a remote/D-pad-driven device has no touch input to lock
       in the first place. marginDp is computed by the caller (onCreate) rather than
       hardcoded here - the same 44dp-per-button stacking chrome.js's registerControlButton
       uses for its own corner control row on the web leg, needed since this button no
       longer always sits immediately left of the hamburger (the Episodes button, when
       present, takes that slot instead - see buildEpisodesButton/onCreate). */
    static void buildLockButton(PlayerActivity activity, float density, int marginDp) {
        LockIconView btn = new LockIconView(activity);
        btn.setContentDescription("Lock touch controls");
        btn.setOnClickListener(v -> activity.setTouchLocked(true));
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams((int) (40 * density), (int) (40 * density));
        params.gravity = Gravity.TOP | Gravity.END;
        params.setMargins(0, (int) (24 * density), (int) (marginDp * density), 0);
        btn.setLayoutParams(params);
        activity.root.addView(btn);
        activity.registerFadingControl(btn);
    }

    /* Only built when there's an actual queue to browse (activity.queueLength > 1,
       mirroring web-fallback.js's queueRatingKeys.length > 1 gate on episode-list.js's own
       button) - same "never an empty/dead affordance" rule the Chapters/Audio Track rows
       already follow. Takes the slot immediately left of the hamburger (marginDp computed
       by onCreate) since it's the next-most-common action after the options menu. Tapping
       it has no Plex data to show yet - it just asks JS for the queue (requestEpisodeList,
       mirroring seekToAdjacentTitle's own "report a bare request, let JS resolve the Plex
       side" split) and PlayerUiHelper.openEpisodeListMenu renders whatever comes back. */
    static void buildEpisodesButton(PlayerActivity activity, float density, int marginDp) {
        /* Drawn via EpisodeListIconView (mirrors src/player/ui/shared.js's
           episodeListIconMarkup() exactly) rather than a text glyph like the other top
           buttons here - no single font character matches that icon, and this keeps the
           button visually identical to its web counterpart instead of an unrelated glyph. */
        EpisodeListIconView btn = new EpisodeListIconView(activity);
        btn.setContentDescription("Episodes");
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams((int) (40 * density), (int) (40 * density));
        params.gravity = Gravity.TOP | Gravity.END;
        params.setMargins(0, (int) (24 * density), (int) (marginDp * density), 0);
        btn.setLayoutParams(params);
        btn.setOnClickListener(v -> {
            /* Shown right away rather than waiting for the round trip below to resolve -
               episode-list.js's queue fetch is a real per-episode Plex round-trip on the
               first open of a given queue, not instant, and a bare tap with no feedback
               at all reads as broken while that's in flight. */
            showEpisodeListLoading(activity);
            PlayerActivity.requestEpisodeList();
        });
        activity.root.addView(btn);
        activity.registerFadingControl(btn);
    }

    /* Full-screen, added last in onCreate so it sits on top of every other view in z-order
       (root is a plain FrameLayout - child order is stacking order) - that's what lets it
       intercept every touch ahead of playerView's own tap/double-tap/fling/pinch
       GestureDetector and every button underneath once locked, rather than needing a
       locked-check threaded through each of those separately. Built once, toggled
       VISIBLE/GONE by setTouchLocked rather than added/removed from the view tree per
       lock/unlock cycle. A tap surfaces the "long-press to unlock" message; the overlay's
       own GestureDetector.onLongPress is the only way out. */
    static void buildLockOverlay(PlayerActivity activity, float density) {
        FrameLayout overlay = new FrameLayout(activity);
        overlay.setVisibility(View.GONE);

        TextView message = new TextView(activity);
        message.setText("Long-press to unlock");
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
                activity.setTouchLocked(false);
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
        float shownColorBoostStrength = activity.colorBoostAuto ? activity.autoColorBoostStrength : activity.colorBoostStrength;
        String colorBoostLine = "Color Boost: " + (activity.colorBoostEnabled
            ? Math.round(shownColorBoostStrength * 100) + "%" + (activity.colorBoostAuto ? " (auto)" : "")
            : "off");

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
        sb.append('\n').append(shaderLine).append('\n').append(colorBoostLine).append('\n').append(qualityCapLine);
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
       just hidden on touch, reachable instead via the Chapters entry in the hamburger menu
       (see openChapterMenu). Fire TV/remote-driven devices report no touchscreen and have
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
       buildCenterControlsRow's header comment) since swipe left/right on the video
       surface already covers it there (see PlayerActivity's tapGestureDetector) - only
       play/pause, which has no gesture equivalent, is unconditional. Registered as one
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
       check, and PlayerActivity's own queueIndex/queueLength guard before calling this
       from a left-swipe). "Prev" jumps back to the actual previous queued title only when
       one exists and playback is still within TITLE_PREV_RESTART_MS of the start;
       otherwise it just restarts the current title from 0, the same convention
       seekToAdjacentChapter above uses for prev-track buttons. Either jump is reported
       back to JS as a bare index (see PlayerActivity.requestTitleNav) rather than
       resolved here - the actual Plex metadata fetch for whichever adjacent title gets
       requested belongs to plex-player.js's fetchQueuedTitle/playQueuedTitle, one
       implementation shared with the web leg instead of duplicated into Java. Package-
       private (not private) since PlayerActivity's swipe-to-change-title gesture calls
       this directly too, not just makeTitleSkipButton. */
    static void seekToAdjacentTitle(PlayerActivity activity, boolean forward) {
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

    // ---- Options menu: glass-panel PopupWindow flyouts, mirroring chrome.js's
    // ---- openHamburgerMenu/openInlineMenu/openShaderMenu instead of a native
    // ---- PopupMenu/AlertDialog.

    private static final class MenuRow {
        final String label;
        String value;
        boolean chevron;
        Boolean toggleChecked;
        Function<Boolean, String> onToggle;
        Runnable onSelect;
        /* Only openChapterMenu sets this - every other caller leaves it null, so
           makeMenuRowView's thumbnail block is a no-op for every other menu. */
        String thumbUrl;

        MenuRow(String label) {
            this.label = label;
        }
    }

    static void showPlayerMenu(PlayerActivity activity, View anchor) {
        List<MenuRow> rows = new ArrayList<>();

        MenuRow speedRow = new MenuRow("Playback Speed");
        float currentRate = activity.player != null ? activity.player.getPlaybackParameters().speed : 1f;
        speedRow.value = formatRate(currentRate);
        speedRow.chevron = true;
        speedRow.onSelect = () -> openSpeedMenu(activity, anchor);
        rows.add(speedRow);

        MenuRow sleepRow = new MenuRow("Sleep Timer");
        sleepRow.value = activity.sleepMinutes > 0 ? activity.sleepMinutes + "m" : null;
        sleepRow.chevron = true;
        sleepRow.onSelect = () -> openSleepMenu(activity, anchor);
        rows.add(sleepRow);

        MenuRow autoPlayRow = new MenuRow("Auto-Play");
        autoPlayRow.toggleChecked = activity.autoPlayEnabled;
        /* No chevron/onSelect - same plain on/off row as Performance Overlay below,
           nothing to drill into. */
        autoPlayRow.onToggle = (checked) -> {
            activity.setAutoPlayEnabled(checked);
            return null;
        };
        rows.add(autoPlayRow);

        /* No inline toggle any more - Auto/On/Off is a 3-way mode, not a boolean, so it
           needs the panel's own segmented control (see openShaderPanel) rather than a
           SwitchCompat that fits this row. Same chevron-only, drill-in-to-change pattern
           as Sleep Timer/Zoom/Playback Speed above. */
        MenuRow shaderRow = new MenuRow("Shader Upscaling");
        shaderRow.value = activity.shaderEnabled ? shaderRowLabel(activity) : null;
        shaderRow.chevron = true;
        shaderRow.onSelect = () -> openShaderPanel(activity, anchor);
        rows.add(shaderRow);

        MenuRow colorBoostRow = new MenuRow("Color Boost");
        colorBoostRow.value = activity.colorBoostEnabled ? colorBoostRowLabel(activity) : null;
        colorBoostRow.chevron = true;
        colorBoostRow.onSelect = () -> openColorBoostPanel(activity, anchor);
        rows.add(colorBoostRow);

        MenuRow ambientRow = new MenuRow("Ambient Lighting");
        ambientRow.toggleChecked = activity.ambientEnabled;
        ambientRow.chevron = true;
        /* Flips on/off in place without leaving this menu - onSelect (tap anywhere else
           on the row) still drills into the opacity panel, same independent-gestures-
           on-one-row pattern as Shader Upscaling above. */
        ambientRow.onToggle = (checked) -> {
            activity.setAmbientEnabled(checked);
            return null;
        };
        ambientRow.onSelect = () -> openAmbientPanel(activity, anchor);
        rows.add(ambientRow);

        MenuRow statsRow = new MenuRow("Performance Overlay");
        statsRow.toggleChecked = activity.statsOverlayEnabled;
        /* No chevron/onSelect - nothing to drill into, unlike Shader Upscaling/Color
           Boost/Ambient Lighting above (each has a strength/opacity slider). Toggling
           this is just a View visibility flip (see setStatsOverlayEnabled), so it's a
           plain on/off row. */
        statsRow.onToggle = (checked) -> {
            activity.setStatsOverlayEnabled(checked);
            return null;
        };
        rows.add(statsRow);

        if (!activity.chapters.isEmpty()) {
            MenuRow chaptersRow = new MenuRow("Chapters");
            chaptersRow.chevron = true;
            chaptersRow.onSelect = () -> openChapterMenu(activity, anchor);
            rows.add(chaptersRow);
        }

        if (activity.audioStreams.size() > 1) {
            MenuRow audioRow = new MenuRow("Audio Track");
            AudioStreamEntry current = findAudioStream(activity, activity.currentAudioStreamId);
            audioRow.value = current != null ? current.label : null;
            audioRow.chevron = true;
            audioRow.onSelect = () -> openAudioMenu(activity, anchor);
            rows.add(audioRow);
        }

        /* Replaces the old pre-play "Quality" picker that used to live on the web
           card's title-info modal (see plex-player.js's chrome.js openVideoQualityMenu
           for the same change on that leg) - Version/Quality Cap both change what's
           actually being decoded, so they belong to an active session, not a choice
           made before one exists. Always shown (unlike Audio Track, gated on there
           being more than one stream) since Quality Cap always has at least
           "Original" to show. */
        MenuRow qualityRow = new MenuRow("Video Quality");
        qualityRow.value = qualityCapDisplayLabel(activity);
        qualityRow.chevron = true;
        qualityRow.onSelect = () -> openVideoQualityMenu(activity, anchor);
        rows.add(qualityRow);

        openMenuPanel(activity, anchor, rows, null);
    }

    /* {label, kbps} pairs mirroring shared.js's QUALITY_CAP_PRESETS on the web leg -
       null kbps is "Original" (no cap), matched by identity in openQualityCapMenu/
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

    /* Sub-menu for the Video Quality row above - Version (only shown when this item
       actually has more than one Media[] entry, same "never an empty/dead affordance"
       rule Audio Track follows) and Quality Cap, each drilling one level further in
       rather than both living on this one panel, matching how Speed/Sleep Timer
       already drill from the top-level menu. */
    private static void openVideoQualityMenu(PlayerActivity activity, View anchor) {
        List<MenuRow> rows = new ArrayList<>();
        if (activity.mediaVersions.size() > 1) {
            MenuRow versionRow = new MenuRow("Version");
            MediaVersionEntry current = findMediaVersion(activity, activity.currentMediaIndex);
            versionRow.value = current != null ? current.label : null;
            versionRow.chevron = true;
            versionRow.onSelect = () -> openVersionMenu(activity, anchor);
            rows.add(versionRow);
        }
        MenuRow capRow = new MenuRow("Quality Cap");
        capRow.value = qualityCapDisplayLabel(activity);
        capRow.chevron = true;
        capRow.onSelect = () -> openQualityCapMenu(activity, anchor);
        rows.add(capRow);
        openMenuPanel(activity, anchor, rows, () -> showPlayerMenu(activity, anchor));
    }

    private static MediaVersionEntry findMediaVersion(PlayerActivity activity, int mediaIndex) {
        for (MediaVersionEntry entry : activity.mediaVersions) {
            if (entry.mediaIndex == mediaIndex) return entry;
        }
        return null;
    }

    private static void openVersionMenu(PlayerActivity activity, View anchor) {
        List<MenuRow> rows = new ArrayList<>();
        for (MediaVersionEntry entry : activity.mediaVersions) {
            boolean isCurrent = entry.mediaIndex == activity.currentMediaIndex;
            MenuRow row = new MenuRow(entry.label + (isCurrent ? "  ✓" : ""));
            row.onSelect = () -> activity.switchMediaVersion(entry.mediaIndex);
            rows.add(row);
        }
        openMenuPanel(activity, anchor, rows, () -> openVideoQualityMenu(activity, anchor));
    }

    private static void openQualityCapMenu(PlayerActivity activity, View anchor) {
        List<MenuRow> rows = new ArrayList<>();
        MenuRow autoRow = new MenuRow("Auto" + (activity.autoQualityEnabled ? "  ✓" : ""));
        autoRow.onSelect = () -> activity.setAutoQualityEnabled(true);
        rows.add(autoRow);
        for (QualityCapPreset preset : QUALITY_CAP_PRESETS) {
            boolean isCurrent = !activity.autoQualityEnabled && java.util.Objects.equals(preset.kbps, activity.qualityCapKbps);
            MenuRow row = new MenuRow(preset.label + (isCurrent ? "  ✓" : ""));
            row.onSelect = () -> {
                activity.setAutoQualityEnabled(false);
                activity.switchQualityCap(preset.kbps);
            };
            rows.add(row);
        }
        openMenuPanel(activity, anchor, rows, () -> openVideoQualityMenu(activity, anchor));
    }

    /* The hamburger row's value text (no inline toggle any more, see the mode row below)
       - "Auto" replaces the numeric % once strength is computed dynamically (see
       ContentAnalysisSampler) rather than showing a live-ticking percentage, matching
       chrome.js's shaderRowLabel/colorBoostRowLabel on the web leg. */
    private static String shaderRowLabel(PlayerActivity activity) {
        return activity.upscaleAuto ? activity.detectedShaderType.label + " (Auto)" : activity.detectedShaderType.label;
    }

    private static String colorBoostRowLabel(PlayerActivity activity) {
        return activity.colorBoostAuto ? "Auto" : Math.round(activity.colorBoostStrength * 100) + "%";
    }

    private static final String[] MODE_KEYS = { "auto", "on", "off" };
    private static final String[] MODE_LABELS = { "Auto", "On", "Off" };

    /* Shared by openShaderPanel/openColorBoostPanel's mode row - disables the manual
       SeekBar and snapshots the current auto-resolved value into its label only in
       "auto" mode ("on"/"off" both leave it showing/editable at the manual value, same
       as the old enabled-toggle-off case always did), matching chrome.js's
       applyStrengthDisplay on the web leg. Deliberately never calls
       strengthSeekBar.setProgress() while auto is selected - unlike a plain HTML range
       input, SeekBar.setProgress() fires onProgressChanged even for a programmatic
       change, which would silently overwrite the remembered manual strength (see
       openShaderPanel/openColorBoostPanel's own SeekBar listeners) with whatever the
       auto snapshot happened to be. */
    private static void applyStrengthDisplay(SeekBar strengthSeekBar, TextView strengthLabel, String mode, float autoValue, float manualValue) {
        boolean auto = "auto".equals(mode);
        strengthSeekBar.setEnabled(!auto);
        strengthSeekBar.setAlpha(auto ? 0.5f : 1f);
        if (!auto) {
            strengthSeekBar.setProgress(Math.round(manualValue * 100));
        }
        int shown = Math.round((auto ? autoValue : manualValue) * 100);
        strengthLabel.setText("Strength: " + shown + "%" + (auto ? " (auto)" : ""));
    }

    /* 3-way Auto/On/Off segmented control replacing the old separate enabled-toggle
       (hamburger row) + "Auto strength" SwitchCompat (panel) pair - see
       PlayerActivity.setUpscaleMode/setColorBoostMode for why the underlying
       shaderEnabled/upscaleAuto (colorBoostEnabled/colorBoostAuto) flags stay as they
       were rather than being replaced outright. Matches chrome.js's buildModeRow on the
       web leg: three equal-weight buttons, tap wires straight through to onModeChange +
       a strength-display refresh, no separate "commit" step. */
    private static void addModeRow(PlayerActivity activity, LinearLayout content, float density, String mode, Consumer<String> onModeChange) {
        LinearLayout row = new LinearLayout(activity);
        row.setOrientation(LinearLayout.HORIZONTAL);
        int gap = Math.round(6 * density);
        LinearLayout.LayoutParams rowParams =
            new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        rowParams.bottomMargin = Math.round(10 * density);
        row.setLayoutParams(rowParams);

        TextView[] buttons = new TextView[MODE_KEYS.length];
        for (int i = 0; i < MODE_KEYS.length; i++) {
            String key = MODE_KEYS[i];
            TextView btn = new TextView(activity);
            btn.setText(MODE_LABELS[i]);
            btn.setGravity(Gravity.CENTER);
            btn.setTextSize(12);
            btn.setTypeface(btn.getTypeface(), android.graphics.Typeface.BOLD);
            int pad = Math.round(6 * density);
            btn.setPadding(0, pad, 0, pad);
            LinearLayout.LayoutParams btnParams = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
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

    private static AudioStreamEntry findAudioStream(PlayerActivity activity, String id) {
        if (id == null) return null;
        for (AudioStreamEntry entry : activity.audioStreams) {
            if (entry.id.equals(id)) return entry;
        }
        return null;
    }

    private static String formatRate(float rate) {
        return rate == Math.floor(rate) ? ((int) rate) + "x" : rate + "x";
    }

    private static void openSpeedMenu(PlayerActivity activity, View anchor) {
        float current = activity.player != null ? activity.player.getPlaybackParameters().speed : 1f;
        List<MenuRow> rows = new ArrayList<>();
        for (float rate : PLAYBACK_RATES) {
            MenuRow row = new MenuRow(formatRate(rate) + (rate == current ? "  ✓" : ""));
            row.onSelect = () -> PlayerActivity.setPlaybackSpeed(rate);
            rows.add(row);
        }
        openMenuPanel(activity, anchor, rows, () -> showPlayerMenu(activity, anchor));
    }

    private static void openSleepMenu(PlayerActivity activity, View anchor) {
        List<MenuRow> rows = new ArrayList<>();
        MenuRow off = new MenuRow("Off" + (activity.sleepMinutes == 0 ? "  ✓" : ""));
        off.onSelect = () -> activity.setSleepTimer(0);
        rows.add(off);
        for (int minutes : SLEEP_TIMER_PRESETS_MIN) {
            MenuRow row = new MenuRow(minutes + " min" + (activity.sleepMinutes == minutes ? "  ✓" : ""));
            row.onSelect = () -> activity.setSleepTimer(minutes * 60_000L);
            rows.add(row);
        }
        MenuRow endOfEpisode = new MenuRow("End of episode");
        endOfEpisode.onSelect = () -> activity.setSleepTimer(0);
        rows.add(endOfEpisode);
        openMenuPanel(activity, anchor, rows, () -> showPlayerMenu(activity, anchor));
    }

    private static void openAudioMenu(PlayerActivity activity, View anchor) {
        List<MenuRow> rows = new ArrayList<>();
        for (AudioStreamEntry entry : activity.audioStreams) {
            boolean isCurrent = entry.id.equals(activity.currentAudioStreamId);
            MenuRow row = new MenuRow(entry.label + (isCurrent ? "  ✓" : ""));
            row.onSelect = () -> activity.switchAudioStream(entry.id);
            rows.add(row);
        }
        openMenuPanel(activity, anchor, rows, () -> showPlayerMenu(activity, anchor));
    }

    private static void openChapterMenu(PlayerActivity activity, View anchor) {
        List<MenuRow> rows = new ArrayList<>();
        for (ChapterEntry chapter : activity.chapters) {
            String time = formatTimestamp(chapter.startTimeOffsetMs);
            MenuRow row = new MenuRow(chapter.title.isEmpty() ? time : time + "  " + chapter.title);
            row.thumbUrl = chapter.thumbUrl;
            row.onSelect = () -> PlayerActivity.seek(chapter.startTimeOffsetMs);
            rows.add(row);
        }
        openMenuPanel(activity, anchor, rows, () -> showPlayerMenu(activity, anchor));
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
        dismissMenuPopup(activity);

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

    /* Shown immediately on the Episodes button tap (see buildEpisodesButton), before JS
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
        dismissMenuPopup(activity);

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
       dismissMenuPopup exists alongside the options-menu PopupWindow. */
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

    /* No more manual Off/Anime4K/Live-Action picker - detectedShaderType came from
       plex-player.js's genre-based detection before this Activity ever launched, shown
       here as read-only info. The SeekBar is the only remaining control; dragging it to
       0% is what "Off" used to be. setVideoEffects() supports being called mid-playback
       (see PlayerActivity.applyVideoEffects's own comment), so there's no Apply/Cancel
       step - matches chrome.js's openShaderMenu panel. */
    private static void openShaderPanel(PlayerActivity activity, View anchor) {
        float density = activity.getResources().getDisplayMetrics().density;
        dismissMenuPopup(activity);

        LinearLayout content = new LinearLayout(activity);
        content.setOrientation(LinearLayout.VERTICAL);
        int pad = Math.round(14 * density);
        content.setPadding(pad, pad, pad, pad);
        content.setBackground(panelBackground(density));
        content.addView(makeBackRow(activity, density, () -> showPlayerMenu(activity, anchor)));

        TextView detectedLabel = new TextView(activity);
        detectedLabel.setText("Detected: " + activity.detectedShaderType.label);
        detectedLabel.setTextColor(Color.WHITE);
        detectedLabel.setTextSize(13);
        detectedLabel.setTypeface(detectedLabel.getTypeface(), android.graphics.Typeface.BOLD);
        content.addView(detectedLabel);

        TextView detectedHint = new TextView(activity);
        detectedHint.setText("Auto-detected from this title's genre");
        detectedHint.setTextColor(VALUE_TEXT);
        detectedHint.setTextSize(11);
        LinearLayout.LayoutParams hintParams =
            new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        hintParams.topMargin = Math.round(2 * density);
        hintParams.bottomMargin = Math.round(10 * density);
        detectedHint.setLayoutParams(hintParams);
        content.addView(detectedHint);

        TextView strengthLabel = new TextView(activity);
        strengthLabel.setTextColor(SUBTLE_TEXT);
        strengthLabel.setTextSize(12);

        SeekBar strengthSeekBar = new SeekBar(activity);
        styleSeekBar(strengthSeekBar, density);
        strengthSeekBar.setMax(100);
        LinearLayout.LayoutParams strengthParams =
            new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        strengthParams.topMargin = Math.round(4 * density);
        strengthSeekBar.setLayoutParams(strengthParams);
        strengthSeekBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar seekBar, int progress, boolean fromUser) {
                /* Label only here - applyVideoEffects() recompiles/relinks a brand-new GL
                   shader program and rebuilds ExoPlayer's whole video-effects pipeline on
                   every call. Calling that at drag frequency previously got the renderer
                   stuck (playback paused and wouldn't resume) - committed once on release
                   instead, below. */
                strengthLabel.setText("Strength: " + progress + "%");
            }

            @Override
            public void onStartTrackingTouch(SeekBar seekBar) {}

            @Override
            public void onStopTrackingTouch(SeekBar seekBar) {
                activity.setShaderStrength(seekBar.getProgress() / 100f);
            }
        });

        addModeRow(activity, content, density, activity.upscaleMode(), (mode) -> {
            activity.setUpscaleMode(mode);
            applyStrengthDisplay(strengthSeekBar, strengthLabel, mode, activity.autoUpscaleStrength, activity.upscaleStrength);
        });
        applyStrengthDisplay(strengthSeekBar, strengthLabel, activity.upscaleMode(), activity.autoUpscaleStrength, activity.upscaleStrength);
        content.addView(strengthLabel);
        content.addView(strengthSeekBar);

        showPopup(activity, anchor, content, density);
    }

    /* Same custom-panel pattern as openShaderPanel above, simpler since there's no
       auto-detected type to show as read-only info here - just the one strength
       control. Gated to onStopTrackingTouch like Shader Upscaling's own panel (not
       live like Ambient Lighting's opacity below) - PlayerActivity.setColorBoostStrength
       goes through applyVideoEffects(), the same GL-program-rebuild-per-call hazard
       documented on openShaderPanel's own SeekBar listener. */
    private static void openColorBoostPanel(PlayerActivity activity, View anchor) {
        float density = activity.getResources().getDisplayMetrics().density;
        dismissMenuPopup(activity);

        LinearLayout content = new LinearLayout(activity);
        content.setOrientation(LinearLayout.VERTICAL);
        int pad = Math.round(14 * density);
        content.setPadding(pad, pad, pad, pad);
        content.setBackground(panelBackground(density));
        content.addView(makeBackRow(activity, density, () -> showPlayerMenu(activity, anchor)));

        TextView strengthLabel = new TextView(activity);
        strengthLabel.setTextColor(SUBTLE_TEXT);
        strengthLabel.setTextSize(12);

        SeekBar strengthSeekBar = new SeekBar(activity);
        styleSeekBar(strengthSeekBar, density);
        strengthSeekBar.setMax(100);
        LinearLayout.LayoutParams strengthParams =
            new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        strengthParams.topMargin = Math.round(4 * density);
        strengthSeekBar.setLayoutParams(strengthParams);
        strengthSeekBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar seekBar, int progress, boolean fromUser) {
                strengthLabel.setText("Strength: " + progress + "%");
            }

            @Override
            public void onStartTrackingTouch(SeekBar seekBar) {}

            @Override
            public void onStopTrackingTouch(SeekBar seekBar) {
                activity.setColorBoostStrength(seekBar.getProgress() / 100f);
            }
        });

        addModeRow(activity, content, density, activity.colorBoostMode(), (mode) -> {
            activity.setColorBoostMode(mode);
            applyStrengthDisplay(strengthSeekBar, strengthLabel, mode, activity.autoColorBoostStrength, activity.colorBoostStrength);
        });
        applyStrengthDisplay(strengthSeekBar, strengthLabel, activity.colorBoostMode(), activity.autoColorBoostStrength, activity.colorBoostStrength);
        content.addView(strengthLabel);
        content.addView(strengthSeekBar);

        showPopup(activity, anchor, content, density);
    }

    /* Same custom-panel pattern as openShaderPanel above, simpler since there's no
       auto-detected type to show as read-only info here, just the one opacity control.
       Unlike strength's SeekBar, this one applies live on every onProgressChanged tick,
       not gated to onStopTrackingTouch - PlayerActivity.setAmbientOpacity is just a
       Paint.setAlpha (see AmbientGlowView.setGlowOpacity), not a GL program rebuild like
       applyVideoEffects, so there's no drag-frequency renderer-freeze risk to guard
       against here. */
    private static void openAmbientPanel(PlayerActivity activity, View anchor) {
        float density = activity.getResources().getDisplayMetrics().density;
        dismissMenuPopup(activity);

        LinearLayout content = new LinearLayout(activity);
        content.setOrientation(LinearLayout.VERTICAL);
        int pad = Math.round(14 * density);
        content.setPadding(pad, pad, pad, pad);
        content.setBackground(panelBackground(density));
        content.addView(makeBackRow(activity, density, () -> showPlayerMenu(activity, anchor)));

        TextView opacityLabel = new TextView(activity);
        opacityLabel.setText("Opacity: " + Math.round(activity.ambientOpacity * 100) + "%");
        opacityLabel.setTextColor(SUBTLE_TEXT);
        opacityLabel.setTextSize(12);
        content.addView(opacityLabel);

        SeekBar opacitySeekBar = new SeekBar(activity);
        styleSeekBar(opacitySeekBar, density);
        opacitySeekBar.setMax(100);
        opacitySeekBar.setProgress(Math.round(activity.ambientOpacity * 100));
        LinearLayout.LayoutParams opacityParams =
            new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        opacityParams.topMargin = Math.round(4 * density);
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
        content.addView(opacitySeekBar);

        showPopup(activity, anchor, content, density);
    }

    private static Drawable panelBackground(float density) {
        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.RECTANGLE);
        bg.setColor(PANEL_BG);
        bg.setCornerRadius(12 * density);
        bg.setStroke(Math.max(1, Math.round(density)), PANEL_BORDER);
        return bg;
    }

    private static Drawable rowPressBackground() {
        StateListDrawable states = new StateListDrawable();
        states.addState(new int[]{android.R.attr.state_pressed}, new ColorDrawable(ROW_PRESSED_BG));
        states.addState(new int[]{}, new ColorDrawable(Color.TRANSPARENT));
        return states;
    }

    private static View makeBackRow(PlayerActivity activity, float density, Runnable onBack) {
        TextView row = new TextView(activity);
        row.setText("‹  Back");
        row.setTextColor(SUBTLE_TEXT);
        row.setTextSize(12);
        row.setTypeface(row.getTypeface(), android.graphics.Typeface.BOLD);
        row.setBackground(rowPressBackground());
        int padH = Math.round(10 * density);
        int padV = Math.round(8 * density);
        row.setPadding(padH, padV, padH, padV);
        LinearLayout.LayoutParams params =
            new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.bottomMargin = Math.round(4 * density);
        row.setLayoutParams(params);
        row.setOnClickListener(v -> onBack.run());
        return row;
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

    private static View makeMenuRowView(PlayerActivity activity, float density, MenuRow item) {
        LinearLayout row = new LinearLayout(activity);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setBackground(rowPressBackground());
        int padH = Math.round(14 * density);
        int padV = Math.round(10 * density);
        row.setPadding(padH, padV, padH, padV);
        row.setLayoutParams(new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        /* Only the Chapters menu sets item.thumbUrl - every other row (speed, sleep
           timer, audio track...) leaves it null, so this is a no-op there. Hidden on
           fetch failure rather than left showing a broken/empty image - a chapter's
           thumb isn't guaranteed to exist just because the chapter itself does. */
        if (item.thumbUrl != null) {
            android.widget.ImageView thumb = new android.widget.ImageView(activity);
            int thumbWidthPx = Math.round(64 * density);
            int thumbHeightPx = Math.round(36 * density);
            LinearLayout.LayoutParams thumbParams = new LinearLayout.LayoutParams(thumbWidthPx, thumbHeightPx);
            thumbParams.setMarginEnd(Math.round(10 * density));
            thumb.setLayoutParams(thumbParams);
            thumb.setScaleType(android.widget.ImageView.ScaleType.CENTER_CROP);
            GradientDrawable thumbBg = new GradientDrawable();
            thumbBg.setColor(Color.argb(20, 255, 255, 255));
            thumbBg.setCornerRadius(4f * density);
            thumb.setBackground(thumbBg);
            thumb.setClipToOutline(true);
            row.addView(thumb);
            String thumbUrl = item.thumbUrl;
            PlexHttp.runAsync(() -> PlexHttp.fetchBitmapSync(thumbUrl), bitmap -> {
                if (bitmap != null) thumb.setImageBitmap(bitmap);
                else thumb.setVisibility(View.GONE);
            });
        }

        LinearLayout labelStack = new LinearLayout(activity);
        labelStack.setOrientation(LinearLayout.VERTICAL);
        labelStack.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        TextView label = new TextView(activity);
        label.setText(item.label);
        label.setTextColor(Color.WHITE);
        label.setTextSize(14);
        labelStack.addView(label);

        TextView valueView = new TextView(activity);
        valueView.setTextColor(VALUE_TEXT);
        valueView.setTextSize(11);
        valueView.setVisibility(item.value != null ? View.VISIBLE : View.GONE);
        if (item.value != null) valueView.setText(item.value);
        labelStack.addView(valueView);
        row.addView(labelStack);

        if (item.toggleChecked != null) {
            SwitchCompat toggle = new SwitchCompat(activity);
            toggle.setChecked(item.toggleChecked);
            toggle.setTrackTintList(toggleTrackTint());
            toggle.setThumbTintList(toggleThumbTint());
            toggle.setOnCheckedChangeListener((buttonView, checked) -> {
                String newValue = item.onToggle != null ? item.onToggle.apply(checked) : null;
                item.value = newValue;
                valueView.setVisibility(newValue != null ? View.VISIBLE : View.GONE);
                if (newValue != null) valueView.setText(newValue);
            });
            LinearLayout.LayoutParams toggleParams =
                new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            toggleParams.setMarginEnd(item.chevron ? Math.round(8 * density) : 0);
            toggle.setLayoutParams(toggleParams);
            row.addView(toggle);
        }

        if (item.chevron) {
            TextView chevron = new TextView(activity);
            chevron.setText("›");
            chevron.setTextColor(SUBTLE_TEXT);
            chevron.setTextSize(16);
            row.addView(chevron);
        }

        row.setOnClickListener(v -> {
            if (item.onSelect != null) item.onSelect.run();
        });
        return row;
    }

    private static void openMenuPanel(PlayerActivity activity, View anchor, List<MenuRow> rows, Runnable onBack) {
        float density = activity.getResources().getDisplayMetrics().density;
        dismissMenuPopup(activity);

        LinearLayout content = new LinearLayout(activity);
        content.setOrientation(LinearLayout.VERTICAL);
        int pad = Math.round(8 * density);
        content.setPadding(pad, pad, pad, pad);
        content.setBackground(panelBackground(density));
        if (onBack != null) content.addView(makeBackRow(activity, density, onBack));
        for (MenuRow row : rows) content.addView(makeMenuRowView(activity, density, row));

        showPopup(activity, anchor, content, density);
    }

    /* Wraps `content` in a PopupWindow anchored below the hamburger/back-anchor, matching
       chrome.js's anchor-below-the-button flyouts. Content taller than maxHeightPx is
       wrapped in a ScrollView instead - PopupWindow's own width/height govern the actual
       window size the ScrollView is laid out against, so capping the window height here
       is what makes the ScrollView actually scroll rather than just growing forever. */
    private static void showPopup(PlayerActivity activity, View anchor, LinearLayout content, float density) {
        int widthPx = Math.round(260 * density);
        int maxHeightPx = Math.round(360 * density);
        content.measure(View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY), View.MeasureSpec.UNSPECIFIED);

        View displayed = content;
        int height = ViewGroup.LayoutParams.WRAP_CONTENT;
        if (content.getMeasuredHeight() > maxHeightPx) {
            ScrollView scroll = new ScrollView(activity);
            scroll.setVerticalScrollBarEnabled(false);
            scroll.addView(content, new ScrollView.LayoutParams(ScrollView.LayoutParams.MATCH_PARENT, ScrollView.LayoutParams.WRAP_CONTENT));
            displayed = scroll;
            height = maxHeightPx;
        }

        PopupWindow popup = new PopupWindow(displayed, widthPx, height, true);
        popup.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        popup.setOutsideTouchable(true);
        popup.setElevation(8 * density);
        popup.setOnDismissListener(() -> {
            if (activity.menuPopup == popup) {
                activity.menuPopup = null;
                showControlsTemporarily(activity);
            }
        });

        activity.menuPopup = popup;
        activity.controlsFadeHandler.removeCallbacks(activity.controlsFadeRunnable);
        setControlsVisible(activity, true);
        /* Right-aligned under the anchor (the hamburger button lives top-right) rather
           than left-aligned, matching chrome.js's menuAnchorPosition for a right-side
           anchor - the panel's right edge lines up with the button's right edge instead
           of overflowing off the right of the screen. */
        int xOffset = anchor.getWidth() - widthPx;
        popup.showAsDropDown(anchor, xOffset, Math.round(8 * density));
    }

    private static void dismissMenuPopup(PlayerActivity activity) {
        if (activity.menuPopup != null) {
            PopupWindow popup = activity.menuPopup;
            activity.menuPopup = null;
            popup.dismiss();
        }
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
