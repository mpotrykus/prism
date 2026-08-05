package com.mpotrykus.streaming;

import android.graphics.Color;
import android.graphics.PorterDuff;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.ProgressBar;
import android.widget.SeekBar;
import android.widget.TextView;

/* Transport-bar/menu/chapter-skip chrome for PlayerActivity, pulled out into its own
   class the same way plex-player.js's web-side transport bar/menus live in
   src/player/ui/chrome.js rather than on the playback controller itself. Every method
   here takes the PlayerActivity instance as an explicit first argument and reads/writes
   its fields directly (those fields are package-private, not private, for exactly this
   reason) rather than through a narrower interface - same "one playback session's
   shared state, not a separable subsystem" reasoning the JS-side split uses. */
final class PlayerUiHelper {
    private PlayerUiHelper() {}

    /* Buffering indicator - independent of fadingControls (same "contextual, not ambient
       chrome" reasoning as the skip button): it reflects actual ExoPlayer state, not user
       activity, so it has to stay visible even once the rest of the chrome has faded out
       from inactivity. Visible from creation since STATE_BUFFERING is also the player's
       state before the first prepare() completes. */
    static void buildLoadingSpinner(PlayerActivity activity) {
        activity.loadingSpinner = new ProgressBar(activity, null, android.R.attr.progressBarStyleLarge);
        activity.loadingSpinner.getIndeterminateDrawable().setColorFilter(Color.WHITE, PorterDuff.Mode.SRC_IN);
        FrameLayout.LayoutParams spinnerParams =
            new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT);
        spinnerParams.gravity = Gravity.CENTER;
        activity.loadingSpinner.setLayoutParams(spinnerParams);
        activity.root.addView(activity.loadingSpinner);
    }

    /* Center overlay: play/pause flanked by previous/next-chapter buttons, matching
       YouTube's mobile layout - only built when the session actually has chapters, same
       "never an empty/dead affordance" rule showPlayerMenu's Chapters entry follows. */
    static void buildCenterControls(PlayerActivity activity, float density) {
        LinearLayout row = new LinearLayout(activity);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        int gapPx = (int) (24 * density);

        if (!activity.chapters.isEmpty()) {
            row.addView(makeChapterSkipButton(activity, false, density, gapPx));
        }

        activity.playPauseButton = new PlayPauseIconView(activity);
        int playSizePx = (int) (64 * density);
        LinearLayout.LayoutParams playParams = new LinearLayout.LayoutParams(playSizePx, playSizePx);
        if (!activity.chapters.isEmpty()) {
            playParams.setMarginStart(gapPx);
            playParams.setMarginEnd(gapPx);
        }
        activity.playPauseButton.setLayoutParams(playParams);
        activity.playPauseButton.setBackgroundColor(Color.parseColor("#8C141414"));
        activity.playPauseButton.setOnClickListener(v -> {
            if (activity.player != null) activity.player.setPlayWhenReady(!activity.player.getPlayWhenReady());
            showControlsTemporarily(activity);
        });
        row.addView(activity.playPauseButton);

        if (!activity.chapters.isEmpty()) {
            row.addView(makeChapterSkipButton(activity, true, density, gapPx));
        }

        FrameLayout.LayoutParams rowParams =
            new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT);
        rowParams.gravity = Gravity.CENTER;
        row.setLayoutParams(rowParams);
        activity.root.addView(row);
        activity.registerFadingControl(row);
    }

    /* forward=true seeks to the next chapter's start; forward=false restarts the current
       chapter once more than a few seconds into it (else jumps to the previous chapter) -
       the same convention as prev-track buttons on physical media remotes. */
    private static View makeChapterSkipButton(PlayerActivity activity, boolean forward, float density, int marginPx) {
        ChapterSkipIconView btn = new ChapterSkipIconView(activity, forward);
        int sizePx = (int) (44 * density);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(sizePx, sizePx);
        if (!forward) params.setMarginEnd(marginPx);
        btn.setLayoutParams(params);
        btn.setBackgroundColor(Color.parseColor("#8C141414"));
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

    /* Bottom transport bar: scrub bar and elapsed/total time - replaces ExoPlayer's own
       controller chrome (disabled via setUseController(false)) with custom-styled UI
       matching the web/Xbox leg's transport bar. */
    static void buildTransportBar(PlayerActivity activity, float density) {
        LinearLayout bar = new LinearLayout(activity);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(Color.parseColor("#BF141414"));
        int vPad = (int) (10 * density);
        int hPad = (int) (16 * density);
        bar.setPadding(hPad, vPad, hPad, vPad);

        activity.timeCurrentText = new TextView(activity);
        activity.timeCurrentText.setText("0:00");
        activity.timeCurrentText.setTextColor(Color.WHITE);
        activity.timeCurrentText.setTextSize(13);
        LinearLayout.LayoutParams currentParams =
            new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        currentParams.setMarginEnd((int) (10 * density));
        activity.timeCurrentText.setLayoutParams(currentParams);
        bar.addView(activity.timeCurrentText);

        activity.transportSeekBar = new SeekBar(activity);
        LinearLayout.LayoutParams seekParams =
            new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        seekParams.setMarginEnd((int) (10 * density));
        activity.transportSeekBar.setLayoutParams(seekParams);
        activity.transportSeekBar.setMax(1000);
        activity.transportSeekBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar seekBar, int progress, boolean fromUser) {
                if (fromUser && activity.player != null) {
                    long duration = activity.player.getDuration();
                    if (duration != androidx.media3.common.C.TIME_UNSET && duration > 0) {
                        activity.timeCurrentText.setText(formatTimestamp(progress * duration / 1000));
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

        activity.timeDurationText = new TextView(activity);
        activity.timeDurationText.setText("0:00");
        activity.timeDurationText.setTextColor(Color.WHITE);
        activity.timeDurationText.setTextSize(13);
        bar.addView(activity.timeDurationText);

        /* A slider isn't offered here the way the web/Xbox leg's transport bar has one -
           the hardware volume rocker already gives fine-grained control over the media
           stream on a real device, so this is mute-only, matching common mobile-player
           convention. */
        activity.muteButton = new TextView(activity);
        activity.muteButton.setText("🔊");
        activity.muteButton.setContentDescription("Mute");
        activity.muteButton.setTextColor(Color.WHITE);
        activity.muteButton.setTextSize(16);
        activity.muteButton.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams muteParams =
            new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        muteParams.setMarginStart((int) (10 * density));
        activity.muteButton.setLayoutParams(muteParams);
        activity.muteButton.setOnClickListener(v -> {
            activity.muted = !activity.muted;
            if (activity.player != null) activity.player.setVolume(activity.muted ? 0f : 1f);
            activity.muteButton.setText(activity.muted ? "🔇" : "🔊");
            activity.muteButton.setContentDescription(activity.muted ? "Unmute" : "Mute");
            showControlsTemporarily(activity);
        });
        bar.addView(activity.muteButton);

        FrameLayout.LayoutParams barParams =
            new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT);
        barParams.gravity = Gravity.BOTTOM;
        bar.setLayoutParams(barParams);
        activity.root.addView(bar);
        activity.registerFadingControl(bar);
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

    /* One menu instead of one bespoke picker View per feature - later phases (chapters,
       quality) add entries here rather than building their own popup/dialog chrome. */
    static void showPlayerMenu(PlayerActivity activity, View anchor) {
        PopupMenu popup = new PopupMenu(activity, anchor);

        android.view.SubMenu speedMenu = popup.getMenu().addSubMenu("Playback Speed");
        float[] rates = {0.25f, 0.5f, 0.75f, 1f, 1.25f, 1.5f, 2f, 4f, 8f};
        for (float rate : rates) {
            String label = (rate == Math.floor(rate)) ? ((int) rate) + "x" : rate + "x";
            speedMenu.add(label).setOnMenuItemClickListener(item -> {
                PlayerActivity.setPlaybackSpeed(rate);
                return true;
            });
        }

        android.view.SubMenu sleepMenu = popup.getMenu().addSubMenu("Sleep Timer");
        sleepMenu.add("Off").setOnMenuItemClickListener(item -> {
            activity.setSleepTimer(0);
            return true;
        });
        int[] sleepMinutes = {15, 30, 45, 60};
        for (int minutes : sleepMinutes) {
            sleepMenu.add(minutes + " min").setOnMenuItemClickListener(item -> {
                activity.setSleepTimer(minutes * 60_000L);
                return true;
            });
        }
        sleepMenu.add("End of episode").setOnMenuItemClickListener(item -> {
            activity.setSleepTimer(0);
            return true;
        });

        /* Hidden entirely rather than shown disabled when there are no chapters - an
           empty popup with nothing explaining it is worse than not offering the entry. */
        if (!activity.chapters.isEmpty()) {
            popup.getMenu().add("Chapters").setOnMenuItemClickListener(item -> {
                showChapterDialog(activity);
                return true;
            });
        }

        /* Same "never an empty/dead affordance" rule as Chapters above - only offered
           when there's actually more than one stream to switch between. */
        if (activity.audioStreams.size() > 1) {
            android.view.SubMenu audioMenu = popup.getMenu().addSubMenu("Audio Track");
            for (AudioStreamEntry entry : activity.audioStreams) {
                audioMenu.add(entry.label).setOnMenuItemClickListener(item -> {
                    activity.switchAudioStream(entry.id);
                    return true;
                });
            }
        }

        /* Off by default - this spends an extra GPU pass on every frame, and the effect is
           only worth the cost on already-low-resolution transcodes/direct-play sources (see
           ShaderUpscaleEffect's isNoOp check, which skips it once the source already fills the
           display). A dialog rather than another PopupMenu entry - a PopupMenu can't host a
           SeekBar, and a continuous strength slider replaced the old fixed-tier preset list. */
        popup.getMenu().add("Shader Upscaling...").setOnMenuItemClickListener(item -> {
            showShaderUpscaleDialog(activity);
            return true;
        });

        popup.show();
    }

    /* No more manual Off/Anime4K/Live-Action RadioGroup - detectedShaderType came from
       plex-player.js's genre-based detection before this Activity ever launched, shown
       here as read-only info. The SeekBar is the only remaining control; dragging it to
       0% is what "Off" used to be (see the shaderType assignment in onStopTrackingTouch
       below). setVideoEffects() supports being called mid-playback (see
       PlayerActivity.applyVideoEffects()'s own comment), so there's no need for an
       Apply/Cancel step. */
    static void showShaderUpscaleDialog(PlayerActivity activity) {
        float density = activity.getResources().getDisplayMetrics().density;
        int pad = (int) (20 * density);
        int labelPad = (int) (8 * density);

        LinearLayout container = new LinearLayout(activity);
        container.setOrientation(LinearLayout.VERTICAL);
        container.setPadding(pad, pad, pad, pad);

        TextView detectedLabel = new TextView(activity);
        detectedLabel.setText("Detected: " + activity.detectedShaderType.label);
        container.addView(detectedLabel);

        TextView detectedHint = new TextView(activity);
        detectedHint.setText("Auto-detected from this title's genre");
        detectedHint.setTextColor(Color.GRAY);
        detectedHint.setTextSize(12);
        detectedHint.setPadding(0, 0, 0, labelPad);
        container.addView(detectedHint);

        TextView strengthLabel = new TextView(activity);
        strengthLabel.setPadding(0, labelPad * 2, 0, labelPad);
        strengthLabel.setText("Strength: " + Math.round(activity.upscaleStrength * 100) + "%");
        container.addView(strengthLabel);

        SeekBar strengthSeekBar = new SeekBar(activity);
        strengthSeekBar.setMax(100);
        strengthSeekBar.setProgress(Math.round(activity.upscaleStrength * 100));
        container.addView(strengthSeekBar);

        strengthSeekBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar seekBar, int progress, boolean fromUser) {
                /* Label only here - applyVideoEffects() recompiles/relinks a brand-new GL shader
                   program and rebuilds ExoPlayer's whole video-effects pipeline on every call.
                   Calling that at drag frequency (many times a second) was what got the renderer
                   stuck (playback paused and wouldn't resume) - it's meant for occasional effect
                   changes, not a continuous scrubber. Committed once on release instead. */
                activity.upscaleStrength = progress / 100f;
                strengthLabel.setText("Strength: " + progress + "%");
            }

            @Override
            public void onStartTrackingTouch(SeekBar seekBar) {}

            @Override
            public void onStopTrackingTouch(SeekBar seekBar) {
                activity.shaderType = activity.upscaleStrength > 0f ? activity.detectedShaderType : ShaderType.OFF;
                activity.applyVideoEffects();
            }
        });

        new androidx.appcompat.app.AlertDialog.Builder(activity)
            .setTitle("Shader Upscaling")
            .setView(container)
            .setPositiveButton("Done", null)
            .show();
    }

    static void showChapterDialog(PlayerActivity activity) {
        String[] labels = new String[activity.chapters.size()];
        for (int i = 0; i < activity.chapters.size(); i++) {
            ChapterEntry c = activity.chapters.get(i);
            labels[i] = c.title.isEmpty() ? formatTimestamp(c.startTimeOffsetMs) : formatTimestamp(c.startTimeOffsetMs) + "  " + c.title;
        }
        new androidx.appcompat.app.AlertDialog.Builder(activity)
            .setTitle("Chapters")
            .setItems(labels, (dialog, index) -> PlayerActivity.seek(activity.chapters.get(index).startTimeOffsetMs))
            .show();
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
            params.setMargins(0, 0, (int) (40 * density), (int) (110 * density));
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
            activity.timeDurationText.setText(formatTimestamp(durationMs));
        }
        activity.timeCurrentText.setText(formatTimestamp(positionMs));
    }
}
