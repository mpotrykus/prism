package com.mpotrykus.streaming;

import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.PorterDuff;
import android.graphics.drawable.ClipDrawable;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.LayerDrawable;
import android.graphics.drawable.StateListDrawable;
import android.text.TextUtils;
import android.view.Gravity;
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
import androidx.media3.common.ColorInfo;
import androidx.media3.common.Format;
import androidx.media3.common.util.UnstableApi;
import java.util.ArrayList;
import java.util.List;
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
    private static final int TRACK_BG = Color.argb(76, 255, 255, 255);
    private static final int REMAINING_TEXT = Color.argb(191, 255, 255, 255);

    private static final float[] PLAYBACK_RATES = {0.25f, 0.5f, 0.75f, 1f, 1.25f, 1.5f, 2f, 4f, 8f};
    private static final int[] SLEEP_TIMER_PRESETS_MIN = {15, 30, 45, 60};

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

    /* "Performance Overlay" gear-menu toggle - a small monospace stats readout, added
       here (not lazily on first toggle like the shader canvas/ambient glow) since it's
       cheap to build and this keeps every corner overlay's construction in one place.
       Positioned below the close/menu buttons' own top row (24dp margin, 40dp tall) so
       it doesn't overlap them, still the "upper left corner" the toggle is named for.
       Independent of fadingControls - same "contextual, not ambient chrome" reasoning as
       the buffering spinner, since a debug overlay should stay visible even once the
       rest of the chrome fades from inactivity, not disappear right when you're trying
       to read it. */
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
        params.setMargins((int) (24 * density), (int) (80 * density), 0, 0);
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
        StringBuilder sb = new StringBuilder();
        sb.append(format != null && format.width > 0 ? format.width + "x" + format.height : "? x ?").append('\n');

        boolean hdr = activity.isHdrContent();
        sb.append("HDR: ").append(hdr ? "yes" : "no");
        ColorInfo colorInfo = format != null ? format.colorInfo : null;
        if (colorInfo != null) {
            sb.append(" (space=").append(colorInfo.colorSpace)
                .append(" transfer=").append(colorInfo.colorTransfer).append(')');
        }
        sb.append('\n');

        sb.append("Shader Upscaling: ").append(activity.shaderType == ShaderType.OFF
            ? "off"
            : activity.shaderType.label + " @ " + Math.round(activity.upscaleStrength * 100) + "%").append('\n');
        sb.append("Color Boost: ").append(activity.colorBoostEnabled
            ? Math.round(activity.colorBoostStrength * 100) + "%"
            : "off");

        text.setText(sb.toString());
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

        activity.transportSeekBar = new SeekBar(activity);
        styleSeekBar(activity.transportSeekBar, density);
        activity.transportSeekBar.setMax(1000);
        LinearLayout.LayoutParams seekParams =
            new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        seekParams.topMargin = (int) (8 * density);
        activity.transportSeekBar.setLayoutParams(seekParams);
        activity.transportSeekBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar seekBar, int progress, boolean fromUser) {
                if (fromUser && activity.player != null) {
                    long duration = activity.player.getDuration();
                    if (duration != androidx.media3.common.C.TIME_UNSET && duration > 0) {
                        long previewMs = progress * duration / 1000;
                        activity.timeRemainingText.setText("-" + formatTimestamp(duration - previewMs));
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
                if (activity.player != null) {
                    long duration = activity.player.getDuration();
                    if (duration != androidx.media3.common.C.TIME_UNSET && duration > 0) {
                        PlayerActivity.seek(seekBar.getProgress() * duration / 1000);
                    }
                }
            }
        });
        bar.addView(activity.transportSeekBar);

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

        LinearLayout rightCell = new LinearLayout(activity);
        rightCell.setOrientation(LinearLayout.HORIZONTAL);
        rightCell.setGravity(Gravity.CENTER_VERTICAL | Gravity.END);
        rightCell.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        activity.muteButton = new VolumeIconView(activity);
        activity.muteButton.setContentDescription("Mute");
        activity.muteButton.setLayoutParams(new LinearLayout.LayoutParams((int) (26 * density), (int) (26 * density)));
        activity.muteButton.setOnClickListener(v -> {
            activity.muted = !activity.muted;
            if (activity.player != null) activity.player.setVolume(activity.muted ? 0f : 1f);
            activity.muteButton.setMuted(activity.muted);
            activity.muteButton.setContentDescription(activity.muted ? "Unmute" : "Mute");
            showControlsTemporarily(activity);
        });
        rightCell.addView(activity.muteButton);
        controlsRow.addView(rightCell);

        bar.addView(controlsRow);

        FrameLayout.LayoutParams barParams =
            new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT);
        barParams.gravity = Gravity.BOTTOM;
        bar.setLayoutParams(barParams);
        activity.root.addView(bar);
        activity.registerFadingControl(bar);
    }

    private static String buildSubtitle(PlayerActivity activity) {
        if (activity.seasonNumber >= 0 && activity.episodeNumber >= 0) {
            return "S" + activity.seasonNumber + " E" + activity.episodeNumber;
        }
        if (activity.year >= 0) {
            return String.valueOf(activity.year);
        }
        return "";
    }

    /* Play/pause flanked by back-5s/forward-5s seek buttons, chapter nav further out when
       the session has chapters - matching chrome.js's buildCenterControls layout (which
       lives inside the transport bar's own center cell, not a separate floating overlay
       like this used to render). */
    private static void buildCenterControlsRow(PlayerActivity activity, LinearLayout row, float density) {
        int gapPx = (int) (14 * density);
        int chapterSizePx = (int) (36 * density);
        int seekSizePx = (int) (44 * density);
        int playSizePx = (int) (60 * density);
        boolean hasChapters = !activity.chapters.isEmpty();

        if (hasChapters) {
            row.addView(makeChapterSkipButton(activity, false), marginEndParams(chapterSizePx, gapPx));
        }

        row.addView(makeSeekButton(activity, false), marginEndParams(seekSizePx, gapPx));

        activity.playPauseButton = new PlayPauseIconView(activity);
        activity.playPauseButton.setOnClickListener(v -> {
            if (activity.player != null) activity.player.setPlayWhenReady(!activity.player.getPlayWhenReady());
            showControlsTemporarily(activity);
        });
        row.addView(activity.playPauseButton, marginEndParams(playSizePx, gapPx));

        row.addView(makeSeekButton(activity, true), marginEndParams(seekSizePx, hasChapters ? gapPx : 0));

        if (hasChapters) {
            row.addView(makeChapterSkipButton(activity, true), new LinearLayout.LayoutParams(chapterSizePx, chapterSizePx));
        }
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

    /* Thin amber-filled track (matching chrome.js's scrub-bar CSS) built from a
       LayerDrawable, the same android.R.id.background/progress convention the platform's
       own progress_horizontal.xml uses - required for SeekBar to recognize which layer to
       clip as playback advances. */
    private static void styleSeekBar(SeekBar seekBar, float density) {
        int trackHeightPx = Math.max(2, Math.round(2 * density));

        GradientDrawable trackBg = new GradientDrawable();
        trackBg.setShape(GradientDrawable.RECTANGLE);
        trackBg.setCornerRadius(trackHeightPx / 2f);
        trackBg.setColor(TRACK_BG);

        GradientDrawable progressShape = new GradientDrawable();
        progressShape.setShape(GradientDrawable.RECTANGLE);
        progressShape.setCornerRadius(trackHeightPx / 2f);
        progressShape.setColor(ACCENT_COLOR);
        ClipDrawable progressClip = new ClipDrawable(progressShape, Gravity.START, ClipDrawable.HORIZONTAL);

        LayerDrawable layers = new LayerDrawable(new Drawable[]{trackBg, progressClip});
        layers.setId(0, android.R.id.background);
        layers.setId(1, android.R.id.progress);
        /* A GradientDrawable stretches to fill whatever bounds it's assigned rather than
           honoring setSize()'s intrinsic-size hint once actual (taller) bounds are given -
           SeekBar always sizes itself well past this thin track for a comfortable touch
           target, so without pinning each layer's height/gravity here the track visually
           stretched to match the widget's full touch height instead of staying thin. */
        layers.setLayerHeight(0, trackHeightPx);
        layers.setLayerGravity(0, Gravity.CENTER_VERTICAL);
        layers.setLayerHeight(1, trackHeightPx);
        layers.setLayerGravity(1, Gravity.CENTER_VERTICAL);
        seekBar.setProgressDrawable(layers);

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

    static void toggleControls(PlayerActivity activity) {
        if (activity.controlsVisible) {
            setControlsVisible(activity, false);
            activity.controlsFadeHandler.removeCallbacks(activity.controlsFadeRunnable);
        } else {
            showControlsTemporarily(activity);
        }
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

        MenuRow shaderRow = new MenuRow("Shader Upscaling");
        shaderRow.value = activity.shaderEnabled ? activity.detectedShaderType.label : null;
        shaderRow.chevron = true;
        shaderRow.toggleChecked = activity.shaderEnabled;
        /* Flips on/off in place without leaving this menu - onSelect (tap anywhere else
           on the row) still drills into the strength panel, same as chrome.js's toggle +
           trailing chevron being independent gestures on one row. */
        shaderRow.onToggle = (checked) -> {
            activity.shaderEnabled = checked;
            activity.shaderType = checked && activity.upscaleStrength > 0f ? activity.detectedShaderType : ShaderType.OFF;
            activity.applyVideoEffects();
            return checked ? activity.detectedShaderType.label : null;
        };
        shaderRow.onSelect = () -> openShaderPanel(activity, anchor);
        rows.add(shaderRow);

        MenuRow colorBoostRow = new MenuRow("Color Boost");
        colorBoostRow.value = activity.colorBoostEnabled ? Math.round(activity.colorBoostStrength * 100) + "%" : null;
        colorBoostRow.chevron = true;
        colorBoostRow.toggleChecked = activity.colorBoostEnabled;
        /* Contrast/saturation "look" lift - independent of Shader Upscaling above (see
           ColorBoostTuning), same toggle-flips-in-place-without-leaving-the-menu
           pattern. */
        colorBoostRow.onToggle = (checked) -> {
            activity.setColorBoostEnabled(checked);
            return checked ? Math.round(activity.colorBoostStrength * 100) + "%" : null;
        };
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

        openMenuPanel(activity, anchor, rows, null);
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
            row.onSelect = () -> PlayerActivity.seek(chapter.startTimeOffsetMs);
            rows.add(row);
        }
        openMenuPanel(activity, anchor, rows, () -> showPlayerMenu(activity, anchor));
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
        strengthLabel.setText("Strength: " + Math.round(activity.upscaleStrength * 100) + "%");
        strengthLabel.setTextColor(SUBTLE_TEXT);
        strengthLabel.setTextSize(12);
        content.addView(strengthLabel);

        SeekBar strengthSeekBar = new SeekBar(activity);
        styleSeekBar(strengthSeekBar, density);
        strengthSeekBar.setMax(100);
        strengthSeekBar.setProgress(Math.round(activity.upscaleStrength * 100));
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
                activity.upscaleStrength = progress / 100f;
                strengthLabel.setText("Strength: " + progress + "%");
            }

            @Override
            public void onStartTrackingTouch(SeekBar seekBar) {}

            @Override
            public void onStopTrackingTouch(SeekBar seekBar) {
                activity.shaderType = activity.shaderEnabled && activity.upscaleStrength > 0f
                    ? activity.detectedShaderType : ShaderType.OFF;
                activity.applyVideoEffects();
            }
        });
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
        strengthLabel.setText("Strength: " + Math.round(activity.colorBoostStrength * 100) + "%");
        strengthLabel.setTextColor(SUBTLE_TEXT);
        strengthLabel.setTextSize(12);
        content.addView(strengthLabel);

        SeekBar strengthSeekBar = new SeekBar(activity);
        styleSeekBar(strengthSeekBar, density);
        strengthSeekBar.setMax(100);
        strengthSeekBar.setProgress(Math.round(activity.colorBoostStrength * 100));
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
        if (activity.transportSeekBar == null || activity.seekBarScrubbing) return;
        if (durationMs > 0) {
            activity.transportSeekBar.setProgress((int) ((positionMs * 1000) / durationMs));
            if (activity.timeRemainingText != null) {
                activity.timeRemainingText.setText("-" + formatTimestamp(Math.max(0, durationMs - positionMs)));
            }
        }
    }
}
