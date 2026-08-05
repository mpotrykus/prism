package com.mpotrykus.streaming;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PorterDuff;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.ScaleGestureDetector;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.ProgressBar;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.SeekBar;
import android.widget.TextView;
import androidx.annotation.OptIn;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.common.Effect;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.ui.PlayerView;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

@OptIn(markerClass = UnstableApi.class)
public class PlayerActivity extends AppCompatActivity {

    public static final String EXTRA_URL = "url";
    public static final String EXTRA_START_POSITION_MS = "startPositionMs";
    public static final String EXTRA_CHAPTERS_JSON = "chaptersJson";

    private static final long PROGRESS_INTERVAL_MS = 1000L;
    private static final long CONTROLS_HIDE_DELAY_MS = 4000L;
    private static final float TAP_SLOP_DP = 8f;

    public interface PlaybackListener {
        void onProgress(long positionMs, long durationMs);
        void onEnded();
        void onError(String message);
        void onStopped(long positionMs);
    }

    private static PlaybackListener listener;
    private static PlayerActivity activeInstance;

    public static void setListener(PlaybackListener l) {
        listener = l;
    }

    private ExoPlayer player;
    private final Handler progressHandler = new Handler(Looper.getMainLooper());
    private final Runnable progressRunnable = this::reportProgress;
    private boolean terminalStateReported = false;
    private final List<View> fadingControls = new ArrayList<>();
    private final Handler sleepTimerHandler = new Handler(Looper.getMainLooper());
    private Runnable sleepTimerRunnable;
    private static final float MAX_ZOOM_SCALE = 4f;
    private float zoomScale = 1f;
    private float panX = 0f;
    private float panY = 0f;
    private float dragStartRawX;
    private float dragStartRawY;
    private float panStartX;
    private float panStartY;
    private boolean isPanning = false;
    private FrameLayout root;
    private TextView skipButton;
    private long skipButtonSeekToMs;
    private ShaderType shaderType = ShaderType.OFF;
    private float upscaleStrength = 0.5f;
    private final Handler controlsFadeHandler = new Handler(Looper.getMainLooper());
    private final Runnable controlsFadeRunnable = () -> setControlsVisible(false);
    private boolean controlsVisible = true;
    private PlayPauseIconView playPauseButton;
    private SeekBar transportSeekBar;
    private TextView timeCurrentText;
    private TextView timeDurationText;
    private boolean seekBarScrubbing = false;
    private ProgressBar loadingSpinner;

    /* Drawn directly rather than a text glyph (the previous "▶"/"⏸" approach) - U+23F8
       PAUSE isn't covered by most system UI fonts, so devices fall back to a placeholder
       glyph for it; Samsung's fallback in particular renders it as a solid orange box
       instead of the usual hollow "tofu" outline. Drawing the shape ourselves sidesteps
       font/emoji-fallback behavior entirely. */
    private static class PlayPauseIconView extends View {
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

    /* Same rationale as PlayPauseIconView above - drawn rather than a "⏮"/"⏭" glyph, which
       sits in the same Unicode block as "⏸" and would hit the same font-fallback issue. */
    private static class ChapterSkipIconView extends View {
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

    /* Native code only ever sees {title, startTimeOffsetMs} - Plex's own Chapter field
       names are interpreted once, in plex-player.js, and never duplicated here. */
    private static class ChapterEntry {
        final String title;
        final long startTimeOffsetMs;

        ChapterEntry(String title, long startTimeOffsetMs) {
            this.title = title;
            this.startTimeOffsetMs = startTimeOffsetMs;
        }
    }

    private final List<ChapterEntry> chapters = new ArrayList<>();
    private String currentUrl;

    /* Chrome that should fade in lockstep via setControlsVisible/showControlsTemporarily
       rather than each new button running its own independent inactivity timer that
       could drift out of sync. */
    private void registerFadingControl(View v) {
        fadingControls.add(v);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        hideSystemBars();

        activeInstance = this;

        String url = getIntent().getStringExtra(EXTRA_URL);
        long startPositionMs = getIntent().getLongExtra(EXTRA_START_POSITION_MS, 0L);
        parseChapters(getIntent().getStringExtra(EXTRA_CHAPTERS_JSON));

        if (url == null || url.isEmpty()) {
            notifyErrorAndFinish("Missing required extra: url");
            return;
        }

        PlayerView playerView = new PlayerView(this);
        playerView.setUseController(false);

        /* An explicit close control, not just reliance on the hardware/gesture back
           button - there's no browser chrome to fall back on once this ships to the
           Xbox WebView2 shell's own native bridge, and it's a more discoverable exit
           than back-button-only even here. */
        root = new FrameLayout(this);
        root.addView(playerView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        float density = getResources().getDisplayMetrics().density;
        TextView closeButton = new TextView(this);
        closeButton.setText("✕");
        closeButton.setTextColor(Color.WHITE);
        closeButton.setTextSize(18);
        closeButton.setGravity(Gravity.CENTER);
        closeButton.setBackgroundColor(Color.parseColor("#B3141414"));
        int sizePx = (int) (44 * density);
        int marginPx = (int) (20 * density);
        FrameLayout.LayoutParams closeParams = new FrameLayout.LayoutParams(sizePx, sizePx);
        closeParams.gravity = Gravity.TOP | Gravity.END;
        closeParams.setMargins(0, marginPx, marginPx, 0);
        closeButton.setLayoutParams(closeParams);
        closeButton.setOnClickListener(v -> onBackPressed());
        root.addView(closeButton);
        registerFadingControl(closeButton);

        /* Every custom option (speed, sleep timer, chapters, shader upscaling) lives
           behind this single button instead of one icon each - see showPlayerMenu. */
        TextView menuButton = new TextView(this);
        menuButton.setText("☰");
        menuButton.setContentDescription("Player options");
        menuButton.setTextColor(Color.WHITE);
        menuButton.setTextSize(18);
        menuButton.setGravity(Gravity.CENTER);
        menuButton.setBackgroundColor(Color.parseColor("#B3141414"));
        FrameLayout.LayoutParams menuParams = new FrameLayout.LayoutParams(sizePx, sizePx);
        menuParams.gravity = Gravity.TOP | Gravity.START;
        menuParams.setMargins(marginPx, marginPx, 0, 0);
        menuButton.setLayoutParams(menuParams);
        menuButton.setOnClickListener(this::showPlayerMenu);
        root.addView(menuButton);
        registerFadingControl(menuButton);

        buildLoadingSpinner();
        buildCenterControls(density);
        buildTransportBar(density);

        setContentView(root);

        /* Pinch-to-zoom + single-finger drag-to-pan directly on the PlayerView surface -
           self-contained here rather than going through the plugin bridge, since it's a
           pure View transform with no Plex-protocol or playback-state involvement. Always
           returns true: this is the only touch consumer on playerView now that its built-in
           controller is disabled, and returning false on ACTION_DOWN (as an earlier version
           of this listener did whenever not zoomed, to let PlayerView's own now-removed
           tap-to-show-controls handling see the event) stops Android from delivering the
           rest of that gesture to this listener at all - ACTION_UP, where the tap-to-toggle
           logic below lives, would simply never arrive. */
        ScaleGestureDetector scaleDetector = new ScaleGestureDetector(this, new ScaleGestureDetector.SimpleOnScaleGestureListener() {
            @Override
            public boolean onScale(ScaleGestureDetector detector) {
                zoomScale = clamp(zoomScale * detector.getScaleFactor(), 1f, MAX_ZOOM_SCALE);
                if (zoomScale <= 1f) {
                    panX = 0f;
                    panY = 0f;
                }
                applyZoomTransform(playerView);
                return true;
            }
        });
        playerView.setOnTouchListener((v, event) -> {
            scaleDetector.onTouchEvent(event);
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    dragStartRawX = event.getRawX();
                    dragStartRawY = event.getRawY();
                    panStartX = panX;
                    panStartY = panY;
                    isPanning = zoomScale > 1f;
                    break;
                case MotionEvent.ACTION_MOVE:
                    if (isPanning && event.getPointerCount() == 1) {
                        float maxPanX = (zoomScale - 1f) * v.getWidth() / 2f;
                        float maxPanY = (zoomScale - 1f) * v.getHeight() / 2f;
                        panX = clamp(panStartX + (event.getRawX() - dragStartRawX), -maxPanX, maxPanX);
                        panY = clamp(panStartY + (event.getRawY() - dragStartRawY), -maxPanY, maxPanY);
                        applyZoomTransform(v);
                    }
                    break;
                case MotionEvent.ACTION_UP:
                    if (!isPanning) {
                        float dx = event.getRawX() - dragStartRawX;
                        float dy = event.getRawY() - dragStartRawY;
                        float slopPx = TAP_SLOP_DP * density;
                        if (Math.abs(dx) < slopPx && Math.abs(dy) < slopPx) {
                            toggleControls();
                        }
                    }
                    isPanning = false;
                    break;
                case MotionEvent.ACTION_CANCEL:
                    isPanning = false;
                    break;
            }
            return true;
        });

        DefaultHttpDataSource.Factory httpDataSourceFactory = new DefaultHttpDataSource.Factory();
        DefaultMediaSourceFactory mediaSourceFactory = new DefaultMediaSourceFactory(this).setDataSourceFactory(httpDataSourceFactory);

        player = new ExoPlayer.Builder(this).setMediaSourceFactory(mediaSourceFactory).build();
        playerView.setPlayer(player);
        /* setVideoEffects() must be called at least once before prepare() even to apply an
           empty (no-op) list - see ExoPlayer's javadoc on the method. */
        applyVideoEffects();

        player.addListener(
            new Player.Listener() {
                @Override
                public void onPlaybackStateChanged(int state) {
                    if (loadingSpinner != null) {
                        loadingSpinner.setVisibility(state == Player.STATE_BUFFERING ? View.VISIBLE : View.GONE);
                    }
                    if (state == Player.STATE_ENDED) {
                        stopProgressLoop();
                        terminalStateReported = true;
                        if (listener != null) {
                            listener.onEnded();
                        }
                        finish();
                    }
                }

                @Override
                public void onPlayerError(PlaybackException error) {
                    notifyErrorAndFinish(error.getMessage());
                }

                @Override
                public void onIsPlayingChanged(boolean isPlaying) {
                    if (playPauseButton != null) {
                        playPauseButton.setPlaying(isPlaying);
                    }
                }
            }
        );

        currentUrl = url;
        MediaItem mediaItem = MediaItem.fromUri(Uri.parse(url));
        player.setMediaItem(mediaItem);
        if (startPositionMs > 0) {
            player.seekTo(startPositionMs);
        }
        player.setPlayWhenReady(true);
        player.prepare();

        startProgressLoop();
        showControlsTemporarily();
    }

    /* Buffering indicator - independent of fadingControls (same "contextual, not ambient
       chrome" reasoning as the skip button): it reflects actual ExoPlayer state, not user
       activity, so it has to stay visible even once the rest of the chrome has faded out
       from inactivity. Visible from creation since STATE_BUFFERING is also the player's
       state before the first prepare() completes. */
    private void buildLoadingSpinner() {
        loadingSpinner = new ProgressBar(this, null, android.R.attr.progressBarStyleLarge);
        loadingSpinner.getIndeterminateDrawable().setColorFilter(Color.WHITE, PorterDuff.Mode.SRC_IN);
        FrameLayout.LayoutParams spinnerParams =
            new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT);
        spinnerParams.gravity = Gravity.CENTER;
        loadingSpinner.setLayoutParams(spinnerParams);
        root.addView(loadingSpinner);
    }

    /* Center overlay: play/pause flanked by previous/next-chapter buttons, matching
       YouTube's mobile layout - only built when the session actually has chapters, same
       "never an empty/dead affordance" rule showPlayerMenu's Chapters entry follows. */
    private void buildCenterControls(float density) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        int gapPx = (int) (24 * density);

        if (!chapters.isEmpty()) {
            row.addView(makeChapterSkipButton(false, density, gapPx));
        }

        playPauseButton = new PlayPauseIconView(this);
        int playSizePx = (int) (64 * density);
        LinearLayout.LayoutParams playParams = new LinearLayout.LayoutParams(playSizePx, playSizePx);
        if (!chapters.isEmpty()) {
            playParams.setMarginStart(gapPx);
            playParams.setMarginEnd(gapPx);
        }
        playPauseButton.setLayoutParams(playParams);
        playPauseButton.setBackgroundColor(Color.parseColor("#8C141414"));
        playPauseButton.setOnClickListener(v -> {
            if (player != null) player.setPlayWhenReady(!player.getPlayWhenReady());
            showControlsTemporarily();
        });
        row.addView(playPauseButton);

        if (!chapters.isEmpty()) {
            row.addView(makeChapterSkipButton(true, density, gapPx));
        }

        FrameLayout.LayoutParams rowParams =
            new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT);
        rowParams.gravity = Gravity.CENTER;
        row.setLayoutParams(rowParams);
        root.addView(row);
        registerFadingControl(row);
    }

    /* forward=true seeks to the next chapter's start; forward=false restarts the current
       chapter once more than a few seconds into it (else jumps to the previous chapter) -
       the same convention as prev-track buttons on physical media remotes. */
    private View makeChapterSkipButton(boolean forward, float density, int marginPx) {
        ChapterSkipIconView btn = new ChapterSkipIconView(this, forward);
        int sizePx = (int) (44 * density);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(sizePx, sizePx);
        if (!forward) params.setMarginEnd(marginPx);
        btn.setLayoutParams(params);
        btn.setBackgroundColor(Color.parseColor("#8C141414"));
        btn.setOnClickListener(v -> {
            seekToAdjacentChapter(forward);
            showControlsTemporarily();
        });
        return btn;
    }

    private void seekToAdjacentChapter(boolean forward) {
        if (player == null || chapters.isEmpty()) return;
        long position = player.getCurrentPosition();
        if (forward) {
            for (ChapterEntry c : chapters) {
                if (c.startTimeOffsetMs > position) {
                    seek(c.startTimeOffsetMs);
                    return;
                }
            }
            return;
        }
        ChapterEntry current = null;
        ChapterEntry previous = null;
        for (ChapterEntry c : chapters) {
            if (c.startTimeOffsetMs <= position) {
                previous = current;
                current = c;
            } else {
                break;
            }
        }
        if (current != null && position - current.startTimeOffsetMs > 3000) {
            seek(current.startTimeOffsetMs);
        } else {
            seek(previous != null ? previous.startTimeOffsetMs : 0);
        }
    }

    /* Bottom transport bar: scrub bar and elapsed/total time - replaces ExoPlayer's own
       controller chrome (disabled via setUseController(false) above) with custom-styled UI
       matching the web/Xbox leg's transport bar. */
    private void buildTransportBar(float density) {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(Color.parseColor("#BF141414"));
        int vPad = (int) (10 * density);
        int hPad = (int) (16 * density);
        bar.setPadding(hPad, vPad, hPad, vPad);

        timeCurrentText = new TextView(this);
        timeCurrentText.setText("0:00");
        timeCurrentText.setTextColor(Color.WHITE);
        timeCurrentText.setTextSize(13);
        LinearLayout.LayoutParams currentParams =
            new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        currentParams.setMarginEnd((int) (10 * density));
        timeCurrentText.setLayoutParams(currentParams);
        bar.addView(timeCurrentText);

        transportSeekBar = new SeekBar(this);
        LinearLayout.LayoutParams seekParams =
            new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        seekParams.setMarginEnd((int) (10 * density));
        transportSeekBar.setLayoutParams(seekParams);
        transportSeekBar.setMax(1000);
        transportSeekBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar seekBar, int progress, boolean fromUser) {
                if (fromUser && player != null) {
                    long duration = player.getDuration();
                    if (duration != androidx.media3.common.C.TIME_UNSET && duration > 0) {
                        timeCurrentText.setText(formatTimestamp(progress * duration / 1000));
                    }
                }
            }

            @Override
            public void onStartTrackingTouch(SeekBar seekBar) {
                seekBarScrubbing = true;
                showControlsTemporarily();
            }

            @Override
            public void onStopTrackingTouch(SeekBar seekBar) {
                seekBarScrubbing = false;
                if (player != null) {
                    long duration = player.getDuration();
                    if (duration != androidx.media3.common.C.TIME_UNSET && duration > 0) {
                        seek(seekBar.getProgress() * duration / 1000);
                    }
                }
            }
        });
        bar.addView(transportSeekBar);

        timeDurationText = new TextView(this);
        timeDurationText.setText("0:00");
        timeDurationText.setTextColor(Color.WHITE);
        timeDurationText.setTextSize(13);
        bar.addView(timeDurationText);

        FrameLayout.LayoutParams barParams =
            new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT);
        barParams.gravity = Gravity.BOTTOM;
        bar.setLayoutParams(barParams);
        root.addView(bar);
        registerFadingControl(bar);
    }

    private void toggleControls() {
        if (controlsVisible) {
            setControlsVisible(false);
            controlsFadeHandler.removeCallbacks(controlsFadeRunnable);
        } else {
            showControlsTemporarily();
        }
    }

    private void showControlsTemporarily() {
        setControlsVisible(true);
        controlsFadeHandler.removeCallbacks(controlsFadeRunnable);
        controlsFadeHandler.postDelayed(controlsFadeRunnable, CONTROLS_HIDE_DELAY_MS);
    }

    /* Fades every registered control (close button, hamburger menu, transport bar) in
       lockstep, replacing ExoPlayer's own controller-visibility fade now that its built-in
       controller is disabled (setUseController(false) above) in favor of this custom chrome.
       Visibility is toggled alongside alpha, not just alpha alone - otherwise a faded-out
       transport bar spanning the full screen width would still intercept touches, creating
       a dead zone where a tap meant to bring the controls back never reaches the
       tap-to-toggle handler on the PlayerView underneath. */
    private void setControlsVisible(boolean visible) {
        controlsVisible = visible;
        for (View v : fadingControls) {
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
    private void showPlayerMenu(View anchor) {
        PopupMenu popup = new PopupMenu(this, anchor);

        android.view.SubMenu speedMenu = popup.getMenu().addSubMenu("Playback Speed");
        float[] rates = {0.25f, 0.5f, 0.75f, 1f, 1.25f, 1.5f, 2f, 4f, 8f};
        for (float rate : rates) {
            String label = (rate == Math.floor(rate)) ? ((int) rate) + "x" : rate + "x";
            speedMenu.add(label).setOnMenuItemClickListener(item -> {
                setPlaybackSpeed(rate);
                return true;
            });
        }

        android.view.SubMenu sleepMenu = popup.getMenu().addSubMenu("Sleep Timer");
        sleepMenu.add("Off").setOnMenuItemClickListener(item -> {
            setSleepTimer(0);
            return true;
        });
        int[] sleepMinutes = {15, 30, 45, 60};
        for (int minutes : sleepMinutes) {
            sleepMenu.add(minutes + " min").setOnMenuItemClickListener(item -> {
                setSleepTimer(minutes * 60_000L);
                return true;
            });
        }
        sleepMenu.add("End of episode").setOnMenuItemClickListener(item -> {
            setSleepTimer(0);
            return true;
        });

        /* Hidden entirely rather than shown disabled when there are no chapters - an
           empty popup with nothing explaining it is worse than not offering the entry. */
        if (!chapters.isEmpty()) {
            popup.getMenu().add("Chapters").setOnMenuItemClickListener(item -> {
                showChapterDialog();
                return true;
            });
        }

        /* Off by default - this spends an extra GPU pass on every frame, and the effect is
           only worth the cost on already-low-resolution transcodes/direct-play sources (see
           ShaderUpscaleEffect's isNoOp check, which skips it once the source already fills the
           display). A dialog rather than another PopupMenu entry - a PopupMenu can't host a
           SeekBar, and a continuous strength slider replaced the old fixed-tier preset list. */
        popup.getMenu().add("Shader Upscaling...").setOnMenuItemClickListener(item -> {
            showShaderUpscaleDialog();
            return true;
        });

        popup.show();
    }

    /* RadioGroup for the shader algorithm (Off/Anime4K/Live-Action) plus a SeekBar for strength,
       applied live on every change - setVideoEffects() supports being called mid-playback (see
       applyVideoEffects()'s own comment), so there's no need for an Apply/Cancel step here. */
    private void showShaderUpscaleDialog() {
        float density = getResources().getDisplayMetrics().density;
        int pad = (int) (20 * density);

        LinearLayout container = new LinearLayout(this);
        container.setOrientation(LinearLayout.VERTICAL);
        container.setPadding(pad, pad, pad, pad);

        RadioGroup shaderGroup = new RadioGroup(this);
        shaderGroup.setOrientation(RadioGroup.VERTICAL);
        ShaderType[] shaderTypes = ShaderType.values();
        RadioButton[] shaderButtons = new RadioButton[shaderTypes.length];
        for (int i = 0; i < shaderTypes.length; i++) {
            RadioButton button = new RadioButton(this);
            button.setId(View.generateViewId());
            button.setText(shaderTypes[i].label);
            shaderGroup.addView(button);
            shaderButtons[i] = button;
            if (shaderTypes[i] == shaderType) {
                shaderGroup.check(button.getId());
            }
        }
        container.addView(shaderGroup);

        TextView strengthLabel = new TextView(this);
        int labelPad = (int) (8 * density);
        strengthLabel.setPadding(0, labelPad * 3, 0, labelPad);
        strengthLabel.setText("Strength: " + Math.round(upscaleStrength * 100) + "%");
        container.addView(strengthLabel);

        SeekBar strengthSeekBar = new SeekBar(this);
        strengthSeekBar.setMax(100);
        strengthSeekBar.setProgress(Math.round(upscaleStrength * 100));
        strengthSeekBar.setEnabled(shaderType != ShaderType.OFF);
        container.addView(strengthSeekBar);

        shaderGroup.setOnCheckedChangeListener((group, checkedId) -> {
            for (int i = 0; i < shaderButtons.length; i++) {
                if (shaderButtons[i].getId() == checkedId) {
                    shaderType = shaderTypes[i];
                    break;
                }
            }
            strengthSeekBar.setEnabled(shaderType != ShaderType.OFF);
            applyVideoEffects();
        });

        strengthSeekBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar seekBar, int progress, boolean fromUser) {
                /* Label only here - applyVideoEffects() recompiles/relinks a brand-new GL shader
                   program and rebuilds ExoPlayer's whole video-effects pipeline on every call.
                   Calling that at drag frequency (many times a second) was what got the renderer
                   stuck (playback paused and wouldn't resume) - it's meant for occasional effect
                   changes, not a continuous scrubber. Committed once on release instead. */
                upscaleStrength = progress / 100f;
                strengthLabel.setText("Strength: " + progress + "%");
            }

            @Override
            public void onStartTrackingTouch(SeekBar seekBar) {}

            @Override
            public void onStopTrackingTouch(SeekBar seekBar) {
                applyVideoEffects();
            }
        });

        new androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("Shader Upscaling")
            .setView(container)
            .setPositiveButton("Done", null)
            .show();
    }

    private void parseChapters(String json) {
        chapters.clear();
        if (json == null) return;
        try {
            org.json.JSONArray arr = new org.json.JSONArray(json);
            for (int i = 0; i < arr.length(); i++) {
                org.json.JSONObject obj = arr.getJSONObject(i);
                chapters.add(new ChapterEntry(obj.optString("title", ""), obj.optLong("startTimeOffsetMs", 0)));
            }
        } catch (org.json.JSONException e) {
            // malformed chapter data - show no chapters rather than crash
        }
    }

    private void showChapterDialog() {
        String[] labels = new String[chapters.size()];
        for (int i = 0; i < chapters.size(); i++) {
            ChapterEntry c = chapters.get(i);
            labels[i] = c.title.isEmpty() ? formatTimestamp(c.startTimeOffsetMs) : formatTimestamp(c.startTimeOffsetMs) + "  " + c.title;
        }
        new androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("Chapters")
            .setItems(labels, (dialog, index) -> seek(chapters.get(index).startTimeOffsetMs))
            .show();
    }

    private static String formatTimestamp(long ms) {
        long totalSeconds = ms / 1000;
        long h = totalSeconds / 3600;
        long m = (totalSeconds % 3600) / 60;
        long s = totalSeconds % 60;
        return h > 0 ? String.format("%d:%02d:%02d", h, m, s) : String.format("%d:%02d", m, s);
    }

    /* Runs entirely on-device rather than round-tripping through the JS/Capacitor bridge -
       pause() is already a static method here, so there's nothing a JS-side setTimeout
       would add except an extra hop. ms=0 clears any pending timer (used by both "Off" and
       "End of episode", which relies on the existing onPlaybackStateChanged(STATE_ENDED)
       handling instead of a timer at all). */
    private void setSleepTimer(long ms) {
        if (sleepTimerRunnable != null) {
            sleepTimerHandler.removeCallbacks(sleepTimerRunnable);
            sleepTimerRunnable = null;
        }
        if (ms > 0) {
            sleepTimerRunnable = PlayerActivity::pause;
            sleepTimerHandler.postDelayed(sleepTimerRunnable, ms);
        }
    }

    /* Lazily created on first marker hit, then just shown/hidden - kept out of
       fadingControls deliberately: it's a contextual action available right now, not
       ambient chrome that should fade on idle, so it doesn't join that shared loop. */
    private void updateSkipButton(String label, long seekToMs) {
        skipButtonSeekToMs = seekToMs;
        if (skipButton == null) {
            float density = getResources().getDisplayMetrics().density;
            skipButton = new TextView(this);
            skipButton.setTextColor(Color.WHITE);
            skipButton.setTextSize(14);
            skipButton.setTypeface(skipButton.getTypeface(), android.graphics.Typeface.BOLD);
            skipButton.setBackgroundColor(Color.parseColor("#D9141414"));
            int hPad = (int) (20 * density);
            int vPad = (int) (10 * density);
            skipButton.setPadding(hPad, vPad, hPad, vPad);
            FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT);
            params.gravity = Gravity.BOTTOM | Gravity.END;
            params.setMargins(0, 0, (int) (40 * density), (int) (110 * density));
            skipButton.setLayoutParams(params);
            skipButton.setOnClickListener(v -> seek(skipButtonSeekToMs));
            root.addView(skipButton);
        }
        skipButton.setText(label);
        skipButton.setVisibility(View.VISIBLE);
    }

    private void hideSkipButtonInternal() {
        if (skipButton != null) {
            skipButton.setVisibility(View.GONE);
        }
    }

    /* Re-issued on every toggle rather than only once at startup - ExoPlayer's javadoc says
       setVideoEffects() can be called again mid-playback to swap the active effect list. */
    private void applyVideoEffects() {
        if (player == null) {
            return;
        }
        List<Effect> effects = shaderType == ShaderType.OFF
            ? Collections.emptyList()
            : Collections.singletonList(new ShaderUpscaleEffect(this, shaderType, upscaleStrength));
        player.setVideoEffects(effects);
    }

    private void applyZoomTransform(View v) {
        v.setScaleX(zoomScale);
        v.setScaleY(zoomScale);
        v.setTranslationX(panX);
        v.setTranslationY(panY);
    }

    private static float clamp(float value, float min, float max) {
        return Math.max(min, Math.min(max, value));
    }

    private void hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (controller != null) {
            controller.hide(WindowInsetsCompat.Type.systemBars());
            controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        }
    }

    private void startProgressLoop() {
        progressHandler.postDelayed(progressRunnable, PROGRESS_INTERVAL_MS);
    }

    private void stopProgressLoop() {
        progressHandler.removeCallbacks(progressRunnable);
    }

    private void reportProgress() {
        if (player != null) {
            long duration = player.getDuration();
            long safeDuration = duration == androidx.media3.common.C.TIME_UNSET ? 0 : duration;
            long position = player.getCurrentPosition();
            if (listener != null) {
                listener.onProgress(position, safeDuration);
            }
            updateTransportUi(position, safeDuration);
        }
        progressHandler.postDelayed(progressRunnable, PROGRESS_INTERVAL_MS);
    }

    private void updateTransportUi(long positionMs, long durationMs) {
        if (transportSeekBar == null || seekBarScrubbing) return;
        if (durationMs > 0) {
            transportSeekBar.setProgress((int) ((positionMs * 1000) / durationMs));
            timeDurationText.setText(formatTimestamp(durationMs));
        }
        timeCurrentText.setText(formatTimestamp(positionMs));
    }

    private void notifyErrorAndFinish(String message) {
        stopProgressLoop();
        terminalStateReported = true;
        if (listener != null) {
            listener.onError(message != null ? message : "Unknown playback error");
        }
        finish();
    }

    public static void pause() {
        if (activeInstance != null && activeInstance.player != null) {
            activeInstance.player.setPlayWhenReady(false);
        }
    }

    public static void resume() {
        if (activeInstance != null && activeInstance.player != null) {
            activeInstance.player.setPlayWhenReady(true);
        }
    }

    public static void seek(long positionMs) {
        if (activeInstance != null && activeInstance.player != null) {
            activeInstance.player.seekTo(positionMs);
        }
    }

    public static void setPlaybackSpeed(float speed) {
        if (activeInstance != null && activeInstance.player != null) {
            activeInstance.player.setPlaybackParameters(new PlaybackParameters(speed));
        }
    }

    /* View mutations, unlike the player-only static methods above, need to run on the
       main thread since Capacitor plugin calls aren't guaranteed to arrive on it. */
    public static void showSkipButton(String label, long seekToMs) {
        if (activeInstance != null) {
            activeInstance.runOnUiThread(() -> activeInstance.updateSkipButton(label, seekToMs));
        }
    }

    public static void hideSkipButton() {
        if (activeInstance != null) {
            activeInstance.runOnUiThread(activeInstance::hideSkipButtonInternal);
        }
    }

    /* Attaches a subtitle track by rebuilding the current MediaItem with the video URI
       unchanged plus a new subtitle config - the transcode session itself (the URL) is
       untouched, only the local MediaItem description changes. setMediaItem's resumeMs
       argument re-prepares in place without restarting from zero - unverified whether
       that's visibly seamless (no rebuffer/flash) on a real device against this specific
       HLS transcode source, see this phase's open risks. */
    public static void setSubtitleUrl(String url, String languageCode, String mimeType) {
        if (activeInstance != null) {
            activeInstance.applySubtitle(url, languageCode, mimeType);
        }
    }

    private void applySubtitle(String url, String languageCode, String mimeType) {
        if (player == null || currentUrl == null) return;
        long resumeMs = player.getCurrentPosition();
        MediaItem.SubtitleConfiguration subtitleConfig = new MediaItem.SubtitleConfiguration.Builder(Uri.parse(url))
            .setMimeType(mimeType)
            .setLanguage(languageCode)
            .build();
        MediaItem newItem = new MediaItem.Builder()
            .setUri(Uri.parse(currentUrl))
            .setSubtitleConfigurations(java.util.Collections.singletonList(subtitleConfig))
            .build();
        player.setMediaItem(newItem, resumeMs);
        player.prepare();
    }

    public static void stopPlayback() {
        if (activeInstance != null) {
            activeInstance.finish();
        }
    }

    @Override
    public void onBackPressed() {
        reportStoppedIfNeeded();
        super.onBackPressed();
    }

    private void reportStoppedIfNeeded() {
        if (!terminalStateReported) {
            terminalStateReported = true;
            long position = player != null ? player.getCurrentPosition() : 0L;
            if (listener != null) {
                listener.onStopped(position);
            }
        }
    }

    @Override
    protected void onDestroy() {
        stopProgressLoop();
        sleepTimerHandler.removeCallbacksAndMessages(null);
        controlsFadeHandler.removeCallbacksAndMessages(null);
        reportStoppedIfNeeded();
        if (player != null) {
            player.release();
            player = null;
        }
        if (activeInstance == this) {
            activeInstance = null;
        }
        super.onDestroy();
    }
}
