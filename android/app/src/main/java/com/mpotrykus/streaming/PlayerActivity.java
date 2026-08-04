package com.mpotrykus.streaming;

import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.TextView;
import androidx.annotation.OptIn;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.ui.PlayerView;

@OptIn(markerClass = UnstableApi.class)
public class PlayerActivity extends AppCompatActivity {

    public static final String EXTRA_URL = "url";
    public static final String EXTRA_START_POSITION_MS = "startPositionMs";

    private static final long PROGRESS_INTERVAL_MS = 1000L;

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

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        hideSystemBars();

        activeInstance = this;

        String url = getIntent().getStringExtra(EXTRA_URL);
        long startPositionMs = getIntent().getLongExtra(EXTRA_START_POSITION_MS, 0L);

        if (url == null || url.isEmpty()) {
            notifyErrorAndFinish("Missing required extra: url");
            return;
        }

        PlayerView playerView = new PlayerView(this);
        playerView.setUseController(true);

        /* An explicit close control, not just reliance on the hardware/gesture back
           button - there's no browser chrome to fall back on once this ships to the
           Xbox WebView2 shell's own native bridge, and it's a more discoverable exit
           than back-button-only even here. */
        FrameLayout root = new FrameLayout(this);
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

        /* Fades the close button in lockstep with ExoPlayer's own controller overlay
           (PlayerView's built-in show-on-tap/hide-after-timeout behavior) rather than
           running a second, independent inactivity timer that could drift out of sync
           with the native controls it's sitting next to. */
        playerView.setControllerVisibilityListener(
            (PlayerView.ControllerVisibilityListener)
                visibility -> closeButton.animate().alpha(visibility == View.VISIBLE ? 1f : 0f).setDuration(200).start()
        );

        setContentView(root);

        DefaultHttpDataSource.Factory httpDataSourceFactory = new DefaultHttpDataSource.Factory();
        DefaultMediaSourceFactory mediaSourceFactory = new DefaultMediaSourceFactory(this).setDataSourceFactory(httpDataSourceFactory);

        player = new ExoPlayer.Builder(this).setMediaSourceFactory(mediaSourceFactory).build();
        playerView.setPlayer(player);

        player.addListener(
            new Player.Listener() {
                @Override
                public void onPlaybackStateChanged(int state) {
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
            }
        );

        MediaItem mediaItem = MediaItem.fromUri(Uri.parse(url));
        player.setMediaItem(mediaItem);
        if (startPositionMs > 0) {
            player.seekTo(startPositionMs);
        }
        player.setPlayWhenReady(true);
        player.prepare();

        startProgressLoop();
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
        if (player != null && listener != null) {
            long duration = player.getDuration();
            listener.onProgress(player.getCurrentPosition(), duration == androidx.media3.common.C.TIME_UNSET ? 0 : duration);
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
