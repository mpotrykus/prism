package com.mpotrykus.streaming;

import android.graphics.Color;
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
import android.widget.ProgressBar;
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
    public static final String EXTRA_AUDIO_STREAMS_JSON = "audioStreamsJson";
    /* Both resolved once in plex-player.js (Settings' global upscale_strength preset +
       detectShaderType's genre check) rather than re-implemented here - one Plex-genre
       interpretation shared by both platforms instead of duplicated in Java. */
    public static final String EXTRA_UPSCALE_STRENGTH = "upscaleStrength";
    public static final String EXTRA_SHADER_TYPE = "shaderType";

    private static final long PROGRESS_INTERVAL_MS = 1000L;
    static final long CONTROLS_HIDE_DELAY_MS = 4000L;
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

    /* Package-private (not private) rather than exposed via getters/setters - PlayerUiHelper
       lives in this same package and is the only outside reader/writer, so a getter/setter
       pair for each of these would just be ceremony around what's still, in effect, one
       playback session's shared state (same reasoning plex-player.js's JS-side modules use
       for taking the controller instance directly instead of a narrower interface). */
    ExoPlayer player;
    private final Handler progressHandler = new Handler(Looper.getMainLooper());
    private final Runnable progressRunnable = this::reportProgress;
    private boolean terminalStateReported = false;
    final List<View> fadingControls = new ArrayList<>();
    private final Handler sleepTimerHandler = new Handler(Looper.getMainLooper());
    private Runnable sleepTimerRunnable;
    private static final float MAX_ZOOM_SCALE = 4f;
    float zoomScale = 1f;
    float panX = 0f;
    float panY = 0f;
    private float dragStartRawX;
    private float dragStartRawY;
    private float panStartX;
    private float panStartY;
    private boolean isPanning = false;
    FrameLayout root;
    TextView skipButton;
    long skipButtonSeekToMs;
    /* detectedShaderType is never OFF - it's just the auto-detected algorithm for this
       title's genre, shown as read-only info in showShaderUpscaleDialog. shaderType is
       the one actually rendered with (OFF whenever upscaleStrength is 0), same "0% is
       off" model as plex-player.js's web-side _setShaderStrength. */
    ShaderType detectedShaderType = ShaderType.LIVE_ACTION;
    ShaderType shaderType = ShaderType.OFF;
    float upscaleStrength = 0f;
    final Handler controlsFadeHandler = new Handler(Looper.getMainLooper());
    final Runnable controlsFadeRunnable = () -> setControlsVisible(false);
    boolean controlsVisible = true;
    PlayPauseIconView playPauseButton;
    SeekBar transportSeekBar;
    TextView timeCurrentText;
    TextView timeDurationText;
    boolean seekBarScrubbing = false;
    ProgressBar loadingSpinner;

    /* PlayPauseIconView, ChapterSkipIconView, ChapterEntry, AudioStreamEntry now live in
       their own files - see PlayerUiHelper.java for the transport-bar/menu/chapter-skip
       code that uses them. */
    final List<ChapterEntry> chapters = new ArrayList<>();
    final List<AudioStreamEntry> audioStreams = new ArrayList<>();
    private String currentUrl;
    boolean muted = false;
    TextView muteButton;

    /* Chrome that should fade in lockstep via setControlsVisible/showControlsTemporarily
       rather than each new button running its own independent inactivity timer that
       could drift out of sync. */
    void registerFadingControl(View v) {
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
        parseAudioStreams(getIntent().getStringExtra(EXTRA_AUDIO_STREAMS_JSON));
        detectedShaderType = parseShaderType(getIntent().getStringExtra(EXTRA_SHADER_TYPE));
        upscaleStrength = getIntent().getFloatExtra(EXTRA_UPSCALE_STRENGTH, 0f);
        shaderType = upscaleStrength > 0f ? detectedShaderType : ShaderType.OFF;

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
                zoomScale = PlayerUiHelper.clamp(zoomScale * detector.getScaleFactor(), 1f, MAX_ZOOM_SCALE);
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
                        panX = PlayerUiHelper.clamp(panStartX + (event.getRawX() - dragStartRawX), -maxPanX, maxPanX);
                        panY = PlayerUiHelper.clamp(panStartY + (event.getRawY() - dragStartRawY), -maxPanY, maxPanY);
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
        PlayerUiHelper.buildLoadingSpinner(this);
    }

    private void buildCenterControls(float density) {
        PlayerUiHelper.buildCenterControls(this, density);
    }

    private void buildTransportBar(float density) {
        PlayerUiHelper.buildTransportBar(this, density);
    }

    private void toggleControls() {
        PlayerUiHelper.toggleControls(this);
    }

    private void showControlsTemporarily() {
        PlayerUiHelper.showControlsTemporarily(this);
    }

    private void setControlsVisible(boolean visible) {
        PlayerUiHelper.setControlsVisible(this, visible);
    }

    private void showPlayerMenu(View anchor) {
        PlayerUiHelper.showPlayerMenu(this, anchor);
    }

    private static ShaderType parseShaderType(String name) {
        return "anime4k".equals(name) ? ShaderType.ANIME4K : ShaderType.LIVE_ACTION;
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

    private void parseAudioStreams(String json) {
        audioStreams.clear();
        if (json == null) return;
        try {
            org.json.JSONArray arr = new org.json.JSONArray(json);
            for (int i = 0; i < arr.length(); i++) {
                org.json.JSONObject obj = arr.getJSONObject(i);
                audioStreams.add(new AudioStreamEntry(obj.optString("id", ""), obj.optString("label", "Unknown")));
            }
        } catch (org.json.JSONException e) {
            // malformed audio-stream data - show no Audio Track entry rather than crash
        }
    }

    /* Runs entirely on-device rather than round-tripping through the JS/Capacitor bridge -
       pause() is already a static method here, so there's nothing a JS-side setTimeout
       would add except an extra hop. ms=0 clears any pending timer (used by both "Off" and
       "End of episode", which relies on the existing onPlaybackStateChanged(STATE_ENDED)
       handling instead of a timer at all). */
    void setSleepTimer(long ms) {
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
        PlayerUiHelper.updateSkipButton(this, label, seekToMs);
    }

    private void hideSkipButtonInternal() {
        PlayerUiHelper.hideSkipButtonInternal(this);
    }

    /* Re-issued on every toggle rather than only once at startup - ExoPlayer's javadoc says
       setVideoEffects() can be called again mid-playback to swap the active effect list. */
    void applyVideoEffects() {
        if (player == null) {
            return;
        }
        List<Effect> effects = shaderType == ShaderType.OFF
            ? Collections.emptyList()
            : Collections.singletonList(new ShaderUpscaleEffect(this, shaderType, upscaleStrength));
        player.setVideoEffects(effects);
    }

    private void applyZoomTransform(View v) {
        PlayerUiHelper.applyZoomTransform(this, v);
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
            PlayerUiHelper.updateTransportUi(this, position, safeDuration);
        }
        progressHandler.postDelayed(progressRunnable, PROGRESS_INTERVAL_MS);
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

    /* Plex bakes the selected audio stream into the HLS transcode at session start, so
       switching tracks means re-requesting the same transcode URL with a new
       audioStreamID (best-known param name for this, unverified against a live request -
       same caveat plex-player.js's _buildStreamUrl already carries for maxVideoBitrate)
       plus a fresh session id and an offset resuming where playback left off. Reuses the
       same "rebuild MediaItem, resume in place" mechanism applySubtitle uses above - note
       this drops any active sidecar subtitle track, the same pre-existing limitation
       applySubtitle already has when called a second time. */
    void switchAudioStream(String streamId) {
        if (player == null || currentUrl == null) return;
        long resumeMs = player.getCurrentPosition();
        Uri oldUri = Uri.parse(currentUrl);
        Uri.Builder builder = oldUri.buildUpon().clearQuery();
        for (String name : oldUri.getQueryParameterNames()) {
            if (name.equals("audioStreamID") || name.equals("offset") || name.equals("session")) continue;
            for (String value : oldUri.getQueryParameters(name)) {
                builder.appendQueryParameter(name, value);
            }
        }
        builder.appendQueryParameter("audioStreamID", streamId);
        builder.appendQueryParameter("offset", String.valueOf(resumeMs / 1000));
        builder.appendQueryParameter("session", java.util.UUID.randomUUID().toString());
        currentUrl = builder.build().toString();
        MediaItem newItem = new MediaItem.Builder().setUri(Uri.parse(currentUrl)).build();
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
