package com.mpotrykus.streaming;

import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.GestureDetector;
import android.view.MotionEvent;
import android.view.ScaleGestureDetector;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.PopupWindow;
import android.widget.ProgressBar;
import android.widget.SeekBar;
import android.widget.TextView;
import androidx.annotation.OptIn;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.media3.common.C;
import androidx.media3.common.ColorInfo;
import androidx.media3.common.Format;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.common.Tracks;
import androidx.media3.common.VideoSize;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.common.Effect;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.analytics.AnalyticsListener;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.source.LoadEventInfo;
import androidx.media3.exoplayer.source.MediaLoadData;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

@OptIn(markerClass = UnstableApi.class)
public class PlayerActivity extends AppCompatActivity {

    private static final String AMBIENT_TAG = "AmbientLighting";
    private static final String SHADER_TAG = "ShaderEffects";

    public static final String EXTRA_URL = "url";
    public static final String EXTRA_START_POSITION_MS = "startPositionMs";
    public static final String EXTRA_CHAPTERS_JSON = "chaptersJson";
    public static final String EXTRA_AUDIO_STREAMS_JSON = "audioStreamsJson";
    /* {mediaIndex, label} per Plex Media[] entry (see native-bridge.js's
       buildPlaybackPayload) plus the currently-selected index/cap - feeds
       PlayerUiHelper's Video Quality menu the same way EXTRA_AUDIO_STREAMS_JSON/
       currentAudioStreamId feed its Audio Track menu. qualityCapKbps has no intent-
       extra default worth using (0 would read as a real cap, not "no cap"), so it's
       read as a boxed Integer via hasExtra/getIntExtra instead - see onCreate. */
    public static final String EXTRA_MEDIA_VERSIONS_JSON = "mediaVersionsJson";
    public static final String EXTRA_CURRENT_MEDIA_INDEX = "currentMediaIndex";
    public static final String EXTRA_QUALITY_CAP_KBPS = "qualityCapKbps";
    /* Full, already-tokened BIF trickplay index URL (see native-bridge.js's
       plexAssetUrl) - fetched/parsed here via BifIndex, not shipped as pre-decoded
       frames, since only the frame nearest wherever the user drags to is ever needed. */
    public static final String EXTRA_BIF_URL = "bifUrl";
    /* Resolved once in plex-player.js from detectShaderType's genre check rather than
       re-implemented here - one Plex-genre interpretation shared by both platforms
       instead of duplicated in Java. shaderEnabled/upscaleStrength/upscaleAuto below are
       NOT passed this way - they're this Activity's own SharedPreferences-persisted
       state (see PREF_COLOR_BOOST_ENABLED and friends), same immediate-persistence model
       as colorBoostEnabled/colorBoostStrength/colorBoostAuto, since there's no JS
       Settings-modal counterpart to seed a per-video default from any more. */
    public static final String EXTRA_SHADER_TYPE = "shaderType";
    /* Shown in the transport bar header (see PlayerUiHelper.buildTransportBar) - same
       title/season-episode-or-year fields web-fallback.js's buildTransportBar reads off
       controller._session directly. -1 (not 0) marks "absent" for the numeric extras
       since 0 is a valid season/episode number. */
    public static final String EXTRA_TITLE = "title";
    /* The episode's own name, distinct from EXTRA_TITLE (the show's name for an episode -
       see plex-netflix-card.js's _playItem, which sends the same two fields split the
       same way). Absent for a movie, which has no second "episode name" on top of its
       own title. */
    public static final String EXTRA_EPISODE_TITLE = "episodeTitle";
    public static final String EXTRA_YEAR = "year";
    public static final String EXTRA_SEASON_NUMBER = "seasonNumber";
    public static final String EXTRA_EPISODE_NUMBER = "episodeNumber";
    /* The ordered queue (a show's full episode order, or a playlist/collection's own
       order) this title came from, if any - mirrors plex-player.js's session-level
       queueRatingKeys/queueIndex. Only the count and current position travel here (see
       NativePlayerPlugin.play) - PlayerUiHelper's title-prev/title-next buttons only need
       them to decide whether "next" should grey out and whether "prev" should restart vs
       jump back; the actual ratingKeys/metadata fetch for whichever adjacent title gets
       requested stays on the JS side (see PlaybackListener.onTitleNavRequested). */
    public static final String EXTRA_QUEUE_LENGTH = "queueLength";
    public static final String EXTRA_QUEUE_INDEX = "queueIndex";

    private static final long PROGRESS_INTERVAL_MS = 1000L;
    static final long CONTROLS_HIDE_DELAY_MS = 4000L;
    /* How long the overlay's "Long-press to unlock" message stays up after a tap while
       touch is locked - see setTouchLocked/showLockMessage. */
    private static final long LOCK_MESSAGE_HIDE_DELAY_MS = 1800L;
    /* Same step the back-5s/forward-5s transport buttons use - see
       PlayerUiHelper.makeSeekButton. Only reachable via the double-tap gesture below on
       devices that report a touchscreen (see hasTouchscreen); Fire TV/remote-driven
       devices have no touch input to trigger it at all, so they keep those buttons
       instead - see buildCenterControlsRow. */
    private static final long SEEK_STEP_MS = 5000L;
    /* Minimum horizontal travel (on top of GestureDetector's own fling-velocity
       threshold) before a swipe counts as a deliberate title-change gesture - see
       tapGestureDetector's onFling. */
    private static final float SWIPE_MIN_DISTANCE_DP = 80f;
    private static final String PREFS_NAME = "prism_player_prefs";
    private static final String PREF_AMBIENT_ENABLED = "ambient_lighting_enabled";
    private static final String PREF_AMBIENT_OPACITY = "ambient_lighting_opacity";
    private static final String PREF_UPSCALE_ENABLED = "upscale_enabled";
    private static final String PREF_UPSCALE_STRENGTH = "upscale_strength";
    private static final String PREF_UPSCALE_AUTO = "upscale_auto";
    private static final String PREF_COLOR_BOOST_ENABLED = "color_boost_enabled";
    private static final String PREF_COLOR_BOOST_STRENGTH = "color_boost_strength";
    private static final String PREF_COLOR_BOOST_AUTO = "color_boost_auto";
    private static final String PREF_STATS_OVERLAY_ENABLED = "stats_overlay_enabled";
    private static final String PREF_AUTO_PLAY_ENABLED = "auto_play_enabled";
    private static final String PREF_AUTO_QUALITY_ENABLED = "auto_quality_enabled";

    public interface PlaybackListener {
        void onProgress(long positionMs, long durationMs);
        void onEnded();
        void onError(String message);
        void onStopped(long positionMs);
        void onTitleNavRequested(int newIndex);
        void onEpisodeListRequested();
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
    private AspectRatioFrameLayout contentFrame;
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
    /* Read by PlayerUiHelper.buildCenterControlsRow to decide whether the back-5s/
       forward-5s transport buttons are worth building at all - a device with no
       touchscreen (Fire TV/remote-driven) has no way to produce the double-tap gesture
       that replaces them on touch devices, so it needs to keep the buttons instead. */
    boolean hasTouchscreen;
    FrameLayout root;
    TextView skipButton;
    long skipButtonSeekToMs;
    /* detectedShaderType is never OFF - it's just the auto-detected algorithm for this
       title's genre, shown as read-only info in PlayerUiHelper's shader panel. shaderType
       is the one actually rendered with (OFF whenever disabled or upscaleStrength is 0),
       same "0% is off" model as plex-player.js's web-side _setShaderStrength. */
    ShaderType detectedShaderType = ShaderType.LIVE_ACTION;
    ShaderType shaderType = ShaderType.OFF;
    /* Same immediate-persistence model as ambientEnabled/colorBoostEnabled below - see
       setShaderStrength/setShaderEnabled. No JS Settings-modal default any more (unlike
       this leg's previous EXTRA_UPSCALE_STRENGTH/EXTRA_SHADER_ENABLED intent extras) -
       whatever this was last set to in-player is what every subsequent video starts
       from. */
    float upscaleStrength = 0f;
    /* Independent of upscaleStrength - toggling this off and back on (see the Shader
       Upscaling menu row) must restore whatever strength the slider was already at
       rather than resetting it, the same model shader-pipeline.js's setShaderEnabled/
       setShaderStrength use on the web leg. Same immediate-persistence model as
       upscaleStrength above. */
    boolean shaderEnabled = false;
    /* Same "toggle overrides, doesn't erase" independence from upscaleStrength as
       shaderEnabled above - checking this doesn't touch the slider's own remembered
       position, so unchecking falls straight back to it. Live-computed autoUpscaleStrength
       is never persisted (see ContentAnalysisSampler/updateContentAnalysis) - only this
       on/off flag is, same immediate-persistence model as upscaleStrength/shaderEnabled
       above (see setUpscaleAuto). */
    boolean upscaleAuto = false;
    float autoUpscaleStrength = 0f;
    /* Ambient lighting has no per-video/genre concern to resolve on this leg, so its
       persisted default lives entirely in this Activity's own SharedPreferences (see
       PREFS_NAME/PREF_AMBIENT_ENABLED), read once in onCreate and written back whenever
       the gear-menu toggle flips (see setAmbientEnabled). */
    boolean ambientEnabled = false;
    /* Same immediate-persistence model as ambientEnabled above - see setAmbientOpacity. */
    float ambientOpacity = 0.5f;
    /* Contrast/saturation "look" boost - same immediate-persistence model as ambient
       lighting above (no per-video/genre concern of its own either), but independent of
       shaderType/shaderEnabled/upscaleStrength above: see ShaderUpscaleEffect's own
       header comment for how the two toggles now share one GL pass. */
    boolean colorBoostEnabled = false;
    float colorBoostStrength = 0.5f;
    /* Same immediate-persistence model as colorBoostEnabled/upscaleAuto above -
       live-computed strength itself is never persisted, only this flag - see
       setColorBoostAuto. */
    boolean colorBoostAuto = false;
    float autoColorBoostStrength = 0.5f;
    /* Same immediate-persistence model as ambientEnabled/colorBoostEnabled above - a debug
       readout has no per-video/genre concern to reconcile either. Read view, not player
       state - see PlayerUiHelper.buildStatsOverlay/updateStatsOverlay. */
    boolean statsOverlayEnabled = false;
    /* Same immediate-persistence model as statsOverlayEnabled above - see
       setAutoPlayEnabled. Read by the STATE_ENDED handler below to decide whether to
       advance to the next queued title instead of finish()ing, same queueIndex/
       queueLength check makeTitleSkipButton's enabled state (and chrome.js's
       seekToAdjacentTitle) already use for the next-title button. Defaults to true
       (unlike every other toggle here) - onCreate's SharedPreferences read below shares
       that same default for a user who's never touched this setting at all. */
    boolean autoPlayEnabled = true;
    /* Same "defaults on for a never-touched user" reasoning as autoPlayEnabled above -
       Auto Quality only ever reacts to real degradation (see QualityAbrMonitor), so
       there's no downside to it running from a user's very first session. */
    boolean autoQualityEnabled = true;
    QualityAbrMonitor abrMonitor;
    /* A fresh player's own initial buffering (before the first STATE_READY) isn't a real
       stall - reset to false at the top of createPlayer() so the ABR monitor's
       notifyStall isn't fed a false positive on cold start or right after a title
       switch/quality-cap reload, all of which rebuild the player from scratch. */
    boolean everStartedPlaying = false;
    TextView statsOverlayText;
    PlayerView playerView;
    AmbientGlowView ambientGlowView;
    private AmbientLightSampler ambientSampler;
    private boolean loggedFirstAmbientLayout = false;
    private ContentAnalysisSampler contentSampler;
    int sleepMinutes = 0;
    String currentAudioStreamId;
    /* The currently-open options-menu flyout (see PlayerUiHelper's PopupWindow-based
       menu system) - tracked here, not just a PlayerUiHelper-local variable, since a new
       submenu replaces it and PlayerActivity.onDestroy needs a way to know none is
       leaked, the same "shared session state lives on the activity" reasoning every
       other package-private field here follows. */
    PopupWindow menuPopup;
    /* The Episodes bottom sheet (see PlayerUiHelper.openEpisodeListMenu/closeEpisodeListMenu) -
       added directly into root rather than a PopupWindow like menuPopup above, since a
       PopupWindow is a separate WindowManager window that doesn't inherit this Activity's
       own layoutInDisplayCutoutMode=always - confirmed on a real device (dumpsys window)
       that a full-width PopupWindow's frame was still being clipped to the display's
       cutout-safe area even though the Activity's own window correctly spans edge-to-edge,
       and PopupWindow exposes no public API to opt a popup's window into that same
       cutout-mode flag. Adding straight into root sidesteps the whole problem - it's the
       same window as the video/transport bar, which already renders edge-to-edge. */
    View episodeListScrim;
    View episodeListSheet;
    final Handler controlsFadeHandler = new Handler(Looper.getMainLooper());
    final Runnable controlsFadeRunnable = () -> setControlsVisible(false);
    boolean controlsVisible = true;
    /* Touch-only lock (see hasTouchscreen gate at the buildLockButton/buildLockOverlay
       call sites in onCreate) - see setTouchLocked for what actually toggles. */
    boolean touchLocked = false;
    FrameLayout lockOverlay;
    TextView lockMessageView;
    final Handler lockMessageHandler = new Handler(Looper.getMainLooper());
    final Runnable hideLockMessageRunnable = () -> {
        if (lockMessageView != null) lockMessageView.setVisibility(View.GONE);
    };
    PlayPauseIconView playPauseButton;
    SeekBar transportSeekBar;
    boolean seekBarScrubbing = false;
    ProgressBar loadingSpinner;
    /* Purely visual, drawn behind transportSeekBar - see SegmentedSeekTrackView's own
       header comment. */
    SegmentedSeekTrackView segmentedTrack;
    /* Loaded fire-and-forget in onCreate (see BifIndex.load below) - null until it
       resolves, or forever if this session has no BIF data/the fetch fails, at which
       point the scrub-preview popup just shows a time label with no image. */
    BifIndex bifIndex;
    PopupWindow scrubPreviewPopup;
    android.widget.ImageView scrubPreviewImageView;
    TextView scrubPreviewTimeView;
    /* -1 sentinel for "never shown a preview frame yet this drag" - 0 is a valid real
       timestamp (the very start of the video), so it can't double as that sentinel. */
    long scrubPreviewLastTimeMs = -1L;
    int scrubPreviewRequestId = 0;

    /* PlayPauseIconView, ChapterSkipIconView, ChapterEntry, AudioStreamEntry now live in
       their own files - see PlayerUiHelper.java for the transport-bar/menu/chapter-skip
       code that uses them. */
    final List<ChapterEntry> chapters = new ArrayList<>();
    final List<AudioStreamEntry> audioStreams = new ArrayList<>();
    final List<MediaVersionEntry> mediaVersions = new ArrayList<>();
    int currentMediaIndex = 0;
    /* null means "no cap" (Plex's own "Original") - same convention shared.js's
       QUALITY_CAP_PRESETS uses on the web leg, kept as a boxed Integer rather than a
       primitive so "never set"/"explicitly cleared" both read the same way. */
    Integer qualityCapKbps;
    private String currentUrl;
    String title = "";
    String episodeTitle = "";
    int year = -1;
    int seasonNumber = -1;
    int episodeNumber = -1;
    int queueLength = 0;
    int queueIndex = -1;
    TextView timeRemainingText;
    /* Rebuilt wholesale by applyTitleSwitch on a title change (their per-title state -
       title/subtitle text, chapter-skip button visibility, next-title-enabled - is
       cheaper to tear down and rebuild via the same PlayerUiHelper builder methods
       onCreate already uses than to reach into piecemeal). */
    LinearLayout transportBarView;
    LinearLayout floatingControlsView;

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
        parseMediaVersions(getIntent().getStringExtra(EXTRA_MEDIA_VERSIONS_JSON));
        currentMediaIndex = getIntent().getIntExtra(EXTRA_CURRENT_MEDIA_INDEX, 0);
        qualityCapKbps = getIntent().hasExtra(EXTRA_QUALITY_CAP_KBPS) ? getIntent().getIntExtra(EXTRA_QUALITY_CAP_KBPS, 0) : null;
        String bifUrl = getIntent().getStringExtra(EXTRA_BIF_URL);
        if (bifUrl != null && !bifUrl.isEmpty()) {
            BifIndex.load(bifUrl, index -> bifIndex = index);
        }
        detectedShaderType = parseShaderType(getIntent().getStringExtra(EXTRA_SHADER_TYPE));
        upscaleStrength = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getFloat(PREF_UPSCALE_STRENGTH, 0.65f);
        shaderEnabled = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getBoolean(PREF_UPSCALE_ENABLED, false);
        /* upscaleAuto has to be read before resolving shaderType below - in Auto mode
           the manual strength is irrelevant to whether the shader is "off" (see
           resolveShaderType), so this order matters, not just the values themselves. */
        upscaleAuto = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getBoolean(PREF_UPSCALE_AUTO, false);
        shaderType = resolveShaderType();
        ambientEnabled = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getBoolean(PREF_AMBIENT_ENABLED, false);
        ambientOpacity = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getFloat(PREF_AMBIENT_OPACITY, 0.5f);
        colorBoostEnabled = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getBoolean(PREF_COLOR_BOOST_ENABLED, false);
        colorBoostStrength = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getFloat(PREF_COLOR_BOOST_STRENGTH, 0.5f);
        colorBoostAuto = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getBoolean(PREF_COLOR_BOOST_AUTO, false);
        statsOverlayEnabled = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getBoolean(PREF_STATS_OVERLAY_ENABLED, false);
        /* Defaults to on (unlike every other toggle here, which defaults off) - see
           shared.js's storedAutoPlayEnabled for why. */
        autoPlayEnabled = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getBoolean(PREF_AUTO_PLAY_ENABLED, true);
        /* Same "defaults on" reasoning as autoPlayEnabled above - see shared.js's
           storedAutoQualityEnabled for why. */
        autoQualityEnabled = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getBoolean(PREF_AUTO_QUALITY_ENABLED, true);
        title = getIntent().getStringExtra(EXTRA_TITLE);
        if (title == null) title = "";
        episodeTitle = getIntent().getStringExtra(EXTRA_EPISODE_TITLE);
        if (episodeTitle == null) episodeTitle = "";
        year = getIntent().getIntExtra(EXTRA_YEAR, -1);
        seasonNumber = getIntent().getIntExtra(EXTRA_SEASON_NUMBER, -1);
        episodeNumber = getIntent().getIntExtra(EXTRA_EPISODE_NUMBER, -1);
        queueLength = getIntent().getIntExtra(EXTRA_QUEUE_LENGTH, 0);
        queueIndex = getIntent().getIntExtra(EXTRA_QUEUE_INDEX, -1);

        if (url == null || url.isEmpty()) {
            notifyErrorAndFinish("Missing required extra: url");
            return;
        }

        playerView = new PlayerView(this);
        playerView.setUseController(false);
        /* PlayerView paints its own bounds black by default (its constructor calls
           View.setBackgroundColor - confirmed via the compiled media3-ui aar, not
           documented in its public API) so a letterboxed gap looks intentional in a
           typical app that never touches this. That default is exactly what blocks
           AmbientGlowView from ever showing through PlayerView's own
           AspectRatioFrameLayout letterbox/pillarbox gap, so it's overridden here
           whenever ambient lighting starts enabled - see setAmbientEnabled for the
           toggle-time version of this same override. */
        playerView.setBackgroundColor(ambientEnabled ? Color.TRANSPARENT : Color.BLACK);

        /* An explicit close control, not just reliance on the hardware/gesture back
           button - there's no browser chrome to fall back on once this ships to the
           Xbox WebView2 shell's own native bridge, and it's a more discoverable exit
           than back-button-only even here. */
        root = new FrameLayout(this);
        /* Added before playerView, not after - a FrameLayout stacks children in add
           order, and this needs to render behind playerView rather than on top of it.
           Only meaningfully visible once ambient lighting is on AND playerView's own
           background has gone transparent above, but built unconditionally so toggling
           ambient lighting on mid-session doesn't need to touch the view hierarchy. */
        ambientGlowView = new AmbientGlowView(this);
        ambientGlowView.setGlowOpacity(ambientOpacity);
        root.addView(ambientGlowView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        root.addView(playerView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        hasTouchscreen = getPackageManager().hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN);

        float density = getResources().getDisplayMetrics().density;
        PlayerUiHelper.buildCloseButton(this, density);
        PlayerUiHelper.buildMenuButton(this, density);
        /* Each top-right button after the hamburger claims the next 44dp slot outward -
           same per-button stacking chrome.js's registerControlButton computes for its own
           corner control row - rather than hardcoding every button's margin against a
           fixed neighbor, since which buttons exist (Episodes; Lock) varies per session. */
        int nextRightSlotDp = 68;
        if (queueLength > 1) {
            PlayerUiHelper.buildEpisodesButton(this, density, nextRightSlotDp);
            nextRightSlotDp += 44;
        }
        if (hasTouchscreen) {
            PlayerUiHelper.buildLockButton(this, density, nextRightSlotDp);
            nextRightSlotDp += 44;
        }
        PlayerUiHelper.buildStatsOverlay(this, density);

        buildLoadingSpinner();
        buildTransportBar(density);
        PlayerUiHelper.buildFloatingPlaybackControls(this, density);

        /* Added last (see buildLockOverlay's own header comment for why z-order matters
           here), after every other view root will ever contain at startup. */
        if (hasTouchscreen) {
            PlayerUiHelper.buildLockOverlay(this, density);
        }

        setContentView(root);

        /* Pinch-to-zoom + single-finger drag-to-pan directly on the PlayerView surface -
           self-contained here rather than going through the plugin bridge, since it's a
           pure View transform with no Plex-protocol or playback-state involvement. Always
           returns true: this is the only touch consumer on playerView now that its built-in
           controller is disabled, and returning false on ACTION_DOWN (as an earlier version
           of this listener did whenever not zoomed, to let PlayerView's own now-removed
           tap-to-show-controls handling see the event) stops Android from delivering the
           rest of that gesture to this listener at all - both this detector and
           tapGestureDetector below need every event in a gesture, not just its start. */
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
        /* Tap classification (single tap play/pauses, double tap seeks) is handed to
           GestureDetector rather than a hand-rolled slop check - firing on every tap-up
           directly would also fire once per half of a double-tap, toggling playback on
           then off again while the seek fires in between. onSingleTapConfirmed only fires
           once Android's own double-tap timeout has passed with no second tap, which
           avoids that. This is inert on a device with no touchscreen (see hasTouchscreen)
           since no MotionEvents ever reach it there - Fire TV/remote-driven devices use
           the real play/pause and seek buttons instead, navigated via D-pad focus (see
           buildCenterControlsRow), never this listener. */
        GestureDetector tapGestureDetector = new GestureDetector(this, new GestureDetector.SimpleOnGestureListener() {
            @Override
            public boolean onDown(MotionEvent e) {
                return true;
            }

            /* First tap on a hidden transport bar just reveals it, same as tapping used
               to unconditionally do before double-tap-seek/swipe-title-nav needed tap
               classification at all (see the comment above this detector) - only a tap
               while it's already showing falls through to the transport bar's own
               play/pause button action. Avoids the video pausing/resuming "by surprise"
               the moment someone taps just to bring the controls up. */
            @Override
            public boolean onSingleTapConfirmed(MotionEvent e) {
                if (!controlsVisible) {
                    showControlsTemporarily();
                    return true;
                }
                if (player != null) player.setPlayWhenReady(!player.getPlayWhenReady());
                showControlsTemporarily();
                return true;
            }

            /* Left half rewinds, right half fast-forwards - same 5s step the transport
               bar's back-5s/forward-5s buttons use (see PlayerUiHelper.makeSeekButton). */
            @Override
            public boolean onDoubleTap(MotionEvent e) {
                seekByOffset(e.getX() < playerView.getWidth() / 2f ? -SEEK_STEP_MS : SEEK_STEP_MS);
                return true;
            }

            /* Swipe left advances to the next queued title, swipe right goes back - same
               convention as swiping through a photo/stories carousel (content advances
               leftward). Requires the swipe to be both long enough and predominantly
               horizontal, on top of GestureDetector's own built-in fling-velocity
               threshold, so a mostly-vertical drag or a slow/short one doesn't
               misfire - there's no dedicated "pan" gesture on this surface today
               (zoomScale > 1f's manual drag-to-pan is the only other one), but this still
               guards against it in case that ever changes. */
            @Override
            public boolean onFling(MotionEvent e1, MotionEvent e2, float velocityX, float velocityY) {
                if (e1 == null || zoomScale > 1f) return false;
                float dx = e2.getX() - e1.getX();
                float dy = e2.getY() - e1.getY();
                if (Math.abs(dx) < SWIPE_MIN_DISTANCE_DP * density || Math.abs(dx) < Math.abs(dy) * 2f) return false;
                boolean forward = dx < 0;
                if (forward && (queueIndex < 0 || queueIndex >= queueLength - 1)) return false;
                PlayerUiHelper.seekToAdjacentTitle(PlayerActivity.this, forward);
                showControlsTemporarily();
                return true;
            }
        });
        playerView.setOnTouchListener((v, event) -> {
            scaleDetector.onTouchEvent(event);
            tapGestureDetector.onTouchEvent(event);
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
                case MotionEvent.ACTION_CANCEL:
                    isPanning = false;
                    break;
            }
            return true;
        });

        createPlayer();

        /* getVideoSurfaceView() is only valid once setPlayer() has attached PlayerView's
           internal content view - see AmbientLightSampler's own header comment for why
           this needs the SurfaceView specifically, not PlayerView itself. Built (and,
           if ambientEnabled is already true from a previous session, started)
           unconditionally rather than lazily on first toggle, matching ambientGlowView's
           own "always present, only visible once its background goes transparent" reasoning
           above. */
        ambientSampler = new AmbientLightSampler(playerView.getVideoSurfaceView(),
            (top, bottom, left, right) -> {
                /* Piggybacks the picture-rect recompute onto the sampler's own ~42ms
                   cadence (see AmbientLightSampler) rather than a separate timer -
                   cheap arithmetic, no need for its own loop. */
                layoutGlow();
                ambientGlowView.setColors(top, bottom, left, right);
            });
        if (ambientEnabled) {
            ambientSampler.start();
        }
        layoutGlow();

        /* Same "built unconditionally, started only if already needed from a previous
           session" reasoning as ambientSampler above. */
        contentSampler = new ContentAnalysisSampler(playerView.getVideoSurfaceView(),
            (avgSaturation, edgeEnergy) -> {
                if (colorBoostAuto) {
                    autoColorBoostStrength = AutoStrength.colorBoost(avgSaturation);
                }
                if (upscaleAuto) {
                    autoUpscaleStrength = AutoStrength.upscale(resolveScaleFactor(), edgeEnergy);
                }
                applyVideoEffects();
            });
        updateContentAnalysis();

        /* Built here (after createPlayer() already ran once above) rather than earlier -
           see createPlayer()'s own null-checks on this field for why that ordering is
           safe regardless. */
        abrMonitor = new QualityAbrMonitor(new QualityAbrMonitor.Listener() {
            @Override
            public Integer currentQualityCapKbps() {
                return qualityCapKbps;
            }

            @Override
            public void switchQualityCap(Integer kbps) {
                PlayerActivity.this.switchQualityCap(kbps);
            }
        });
        updateAbrMonitor();

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

    /* Builds a fresh ExoPlayer instance and attaches it to playerView - split out of
       onCreate so applyTitleSwitch can rebuild the player for a title switch too rather
       than reusing the same instance across a stop()+setMediaItem()+prepare() cycle.
       Confirmed on a real device that reusing one instance across a title switch left
       ExoPlayer wedged in STATE_BUFFERING forever with no manifest request for the new
       title ever going out, regardless of whether setVideoEffects() was involved -
       something about replacing a live HLS load's MediaItem on an already-prepared
       player leaves its loader stuck, not just a video-effects-pipeline quirk. A fresh
       instance per title sidesteps whatever internal state that reuse was tripping over.
       playerView's own SurfaceView (and therefore ambientSampler/contentSampler, both
       built once against playerView.getVideoSurfaceView() in onCreate) is untouched by
       this - PlayerView.setPlayer() only rebinds which Player renders into its existing
       surface, it doesn't recreate the surface itself. */
    private void createPlayer() {
        if (player != null) {
            player.release();
        }
        everStartedPlaying = false;
        DefaultHttpDataSource.Factory httpDataSourceFactory = new DefaultHttpDataSource.Factory();
        DefaultMediaSourceFactory mediaSourceFactory = new DefaultMediaSourceFactory(this).setDataSourceFactory(httpDataSourceFactory);
        player = new ExoPlayer.Builder(this).setMediaSourceFactory(mediaSourceFactory).build();
        playerView.setPlayer(player);
        /* setVideoEffects() must be called at least once before prepare() even to apply an
           empty (no-op) list - see ExoPlayer's javadoc on the method. */
        applyVideoEffects();
        /* Feeds QualityAbrMonitor's own bandwidth estimate - ExoPlayer's built-in
           DefaultBandwidthMeter only updates from TransferListener callbacks that the
           bare DefaultHttpDataSource.Factory above never wires up, so onLoadCompleted
           (unambiguous public API, no DataSource.Factory changes needed) stands in as
           the real signal instead. abrMonitor may still be null here on the very first
           createPlayer() call in onCreate (constructed afterward, alongside
           ambientSampler/contentSampler) - null-checked since this listener keeps firing
           for the lifetime of this player instance, long after that field is set. */
        player.addAnalyticsListener(new AnalyticsListener() {
            @Override
            public void onLoadCompleted(EventTime eventTime, LoadEventInfo loadEventInfo, MediaLoadData mediaLoadData) {
                if (abrMonitor != null && mediaLoadData.dataType == C.DATA_TYPE_MEDIA) {
                    abrMonitor.onSegmentLoadCompleted(loadEventInfo.bytesLoaded, loadEventInfo.loadDurationMs);
                }
            }
        });
        player.addListener(
            new Player.Listener() {
                @Override
                public void onPlaybackStateChanged(int state) {
                    if (loadingSpinner != null) {
                        loadingSpinner.setVisibility(state == Player.STATE_BUFFERING ? View.VISIBLE : View.GONE);
                    }
                    /* A fresh player's own first buffer-up (cold start, title switch, or
                       any switchQualityCap/switchMediaVersion/switchAudioStream/
                       applySubtitle reload) isn't a real network stall - everStartedPlaying
                       only flips true once this instance has actually reached STATE_READY
                       once, so this can't fire on that initial buffering. Beyond that,
                       abrMonitor.notifyStall() is itself cooldown-gated (see that class),
                       which is what actually absorbs the buffering our own reload calls
                       cause without a stall being double-counted. */
                    if (state == Player.STATE_BUFFERING && everStartedPlaying && abrMonitor != null) {
                        abrMonitor.notifyStall();
                    }
                    if (state == Player.STATE_READY) {
                        everStartedPlaying = true;
                    }
                    if (state == Player.STATE_ENDED) {
                        /* Same queueIndex/queueLength check the next-title button uses
                           (see PlayerUiHelper.buildFloatingPlaybackControls) - decided
                           natively, before finish() below, rather than deferred to JS's
                           "ended" listener: by the time that event reached JS this
                           Activity would already be gone, too late to switchTitle() into
                           it. requestTitleNav reuses the exact same JS round-trip
                           (titleNav event -> playQueuedTitle -> switchNative) the button
                           and swipe gesture already use, so this reads as one continuous
                           player rather than a close-and-relaunch. */
                        if (autoPlayEnabled && queueIndex >= 0 && queueIndex < queueLength - 1) {
                            requestTitleNav(queueIndex + 1);
                            return;
                        }
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

                @Override
                public void onVideoSizeChanged(VideoSize videoSize) {
                    /* Fires as soon as the real video dimensions are known (typically
                       just after prepare(), before AmbientLightSampler's first tick) -
                       recomputes immediately rather than waiting on that ~42ms
                       cadence, so the glow doesn't start from the "assume no
                       letterboxing" fallback for a visible beat. */
                    layoutGlow();
                }

                @Override
                public void onTracksChanged(Tracks tracks) {
                    /* applyVideoEffects()'s very first call (see below) runs before
                       prepare() even starts, so isHdrContent() has no track format to
                       inspect yet at that point - re-run once ExoPlayer actually
                       resolves the selected video track's colorInfo, so a real HDR
                       source doesn't slip through with the effects pass still
                       attached for the first few frames. */
                    applyVideoEffects();
                }
            }
        );
    }

    /* Buffering indicator - independent of fadingControls (same "contextual, not ambient
       chrome" reasoning as the skip button): it reflects actual ExoPlayer state, not user
       activity, so it has to stay visible even once the rest of the chrome has faded out
       from inactivity. Visible from creation since STATE_BUFFERING is also the player's
       state before the first prepare() completes. */
    private void buildLoadingSpinner() {
        PlayerUiHelper.buildLoadingSpinner(this);
    }

    private void buildTransportBar(float density) {
        PlayerUiHelper.buildTransportBar(this, density);
    }

    private void showControlsTemporarily() {
        PlayerUiHelper.showControlsTemporarily(this);
    }

    private void setControlsVisible(boolean visible) {
        PlayerUiHelper.setControlsVisible(this, visible);
    }

    /* Same clamp-to-[0, duration] behavior as PlayerUiHelper.makeSeekButton's click
       handler - showControlsTemporarily afterward is what lets the user see the new
       position reflected on the transport bar/scrub track, same as a button tap does. */
    private void seekByOffset(long deltaMs) {
        if (player == null) return;
        long duration = player.getDuration();
        long target = player.getCurrentPosition() + deltaMs;
        target = Math.max(0, target);
        if (duration != C.TIME_UNSET && duration > 0) {
            target = Math.min(duration, target);
        }
        seek(target);
        showControlsTemporarily();
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
                String thumbUrl = obj.has("thumbUrl") && !obj.isNull("thumbUrl") ? obj.optString("thumbUrl", null) : null;
                chapters.add(new ChapterEntry(obj.optString("title", ""), obj.optLong("startTimeOffsetMs", 0), thumbUrl));
            }
        } catch (org.json.JSONException e) {
            // malformed chapter data - show no chapters rather than crash
        }
    }

    private void parseAudioStreams(String json) {
        audioStreams.clear();
        currentAudioStreamId = null;
        if (json == null) return;
        try {
            org.json.JSONArray arr = new org.json.JSONArray(json);
            for (int i = 0; i < arr.length(); i++) {
                org.json.JSONObject obj = arr.getJSONObject(i);
                boolean selected = obj.optBoolean("selected", false);
                String id = obj.optString("id", "");
                audioStreams.add(new AudioStreamEntry(id, obj.optString("label", "Unknown"), selected));
                if (selected) currentAudioStreamId = id;
            }
        } catch (org.json.JSONException e) {
            // malformed audio-stream data - show no Audio Track entry rather than crash
        }
    }

    private void parseMediaVersions(String json) {
        mediaVersions.clear();
        if (json == null) return;
        try {
            org.json.JSONArray arr = new org.json.JSONArray(json);
            for (int i = 0; i < arr.length(); i++) {
                org.json.JSONObject obj = arr.getJSONObject(i);
                mediaVersions.add(new MediaVersionEntry(obj.optInt("mediaIndex", i), obj.optString("label", "Version " + (i + 1))));
            }
        } catch (org.json.JSONException e) {
            // malformed media-version data - show no Version entry rather than crash
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
        sleepMinutes = ms > 0 ? (int) (ms / 60_000L) : 0;
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
       setVideoEffects() can be called again mid-playback to swap the active effect list.

       Both Shader Upscaling and Color Boost share one GL pass now (see ShaderUpscaleEffect's
       own header comment) - programType always picks a real algorithm to render through
       (whichever this title's genre auto-detected) even when shader upscaling itself is off,
       with sharpenTuning forced to ShaderType.NEUTRAL in that case rather than
       programType.tuningAt(0) (which would apply that type's lightest-tier sharpen amount, not
       true zero - see ShaderType.NEUTRAL's own comment). */
    void applyVideoEffects() {
        if (player == null) {
            return;
        }
        boolean sharpenOn = shaderType != ShaderType.OFF;
        boolean hdr = isHdrContent();
        if ((!sharpenOn && !colorBoostEnabled) || hdr) {
            Log.d(SHADER_TAG, "applyVideoEffects: no effects ("
                + (hdr ? "HDR content detected, auto-skipping" : "both toggles off") + ")");
            player.setVideoEffects(Collections.emptyList());
            PlayerUiHelper.updateStatsOverlay(this);
            return;
        }
        Log.d(SHADER_TAG, "applyVideoEffects: sharpenOn=" + sharpenOn + " (" + shaderType + " @ " + upscaleStrength
            + "), colorBoostEnabled=" + colorBoostEnabled + " (" + colorBoostStrength + "), hdr=false");
        ShaderType programType = sharpenOn ? shaderType : detectedShaderType;
        /* Auto strength (see ContentAnalysisSampler/AutoStrength) resolves separately
           from upscaleStrength/colorBoostStrength rather than overwriting them - those
           stay the remembered manual slider position, restored the moment auto is
           unchecked, same shape as programType being resolved from shaderType just
           above. */
        float resolvedUpscaleStrength = upscaleAuto ? autoUpscaleStrength : upscaleStrength;
        float resolvedColorBoostStrength = colorBoostAuto ? autoColorBoostStrength : colorBoostStrength;
        /* sharpenOn alone isn't enough to gate this - resolveShaderType keeps shaderType
           resolved to a real type throughout Auto mode regardless of the live auto
           strength (it has to, so ContentAnalysisSampler keeps running for whenever a
           nonzero value does arrive). But tuningAt(0) returns that type's own MIN tuning,
           not true zero (see this method's own header comment on NEUTRAL vs tuningAt(0))
           - the same "0 strength" that means fully off in manual mode (there, shaderType
           itself already becomes OFF at exactly 0, hitting the sharpenOn=false branch
           below) would otherwise render as still-visibly-sharpened once auto legitimately
           computes 0 (source doesn't need upscaling). Checking resolvedUpscaleStrength >
           0f here too is what actually makes a live 0 look like NEUTRAL, regardless of
           which mode produced it. */
        ShaderTuning sharpenTuning = (sharpenOn && resolvedUpscaleStrength > 0f) ? programType.tuningAt(resolvedUpscaleStrength) : ShaderType.NEUTRAL;
        ColorBoostTuning colorTuning = colorBoostEnabled ? ColorBoostTuning.at(resolvedColorBoostStrength) : ColorBoostTuning.NEUTRAL;
        player.setVideoEffects(
            Collections.singletonList(new ShaderUpscaleEffect(this, programType, sharpenTuning, colorTuning)));
        PlayerUiHelper.updateStatsOverlay(this);
    }

    /* Shared by isHdrContent() and resolveVideoAR() below (and PlayerUiHelper's stats
       overlay) rather than each re-walking player.getCurrentTracks() independently - the
       selected video track's Format is the one place resolution/colorInfo/rotation all
       come from. Package-private, not private, so PlayerUiHelper.updateStatsOverlay can
       read the same Format the "HDR: yes/no" line is computed from. */
    Format selectedVideoFormat() {
        if (player == null) return null;
        for (Tracks.Group group : player.getCurrentTracks().getGroups()) {
            if (group.getType() != C.TRACK_TYPE_VIDEO) continue;
            for (int i = 0; i < group.length; i++) {
                if (group.isTrackSelected(i)) return group.getTrackFormat(i);
            }
        }
        return null;
    }

    /* Automatic, not a user-facing toggle - real HDR-mastered sources (wide BT.2020 gamut or a
       PQ/HLG transfer function) skip this GL effects pass entirely rather than composing an
       SDR-tuned contrast/saturation/sharpen boost on top of it, the same reasoning Plezy's own
       ShaderService._isHdrContent()/autoHdrSkip uses (see docs/plezy-player-comparison.md's HDR
       notes) - our shadow-crush fix (see ShaderUpscaleShaderProgram's shadowProtect) was tuned
       against SDR luma assumptions, not PQ/HLG's own much wider range. This is NOT full HDR
       passthrough (no Dolby Vision profile handling, no display HDR-mode switching à la Plezy's
       matchDynamicRange on Windows) - that's tracked separately, deliberately scoped out here;
       see docs/plezy-player-comparison.md's "Deferred features" for the full plan.

       The exact colorSpace/colorTransfer values that drove this decision are surfaced in the
       Performance Overlay's "HDR" line (see PlayerUiHelper.updateStatsOverlay) rather than
       logged here on every call - this runs on the applyVideoEffects()/onTracksChanged() path,
       and logcat isn't where you'd normally be looking to confirm this during real playback. */
    /* How much the source would need to be stretched to fill playerView - same ratio
       renderShaderFrame computes on the web leg, recomputed fresh on every
       ContentAnalysisSampler tick rather than cached, since the window/display metrics
       this depends on can't change mid-session on Android the way a resizable browser
       window can, but the video track's own Format isn't guaranteed known yet on the
       very first tick either. */
    private float resolveScaleFactor() {
        Format format = selectedVideoFormat();
        if (format == null || format.width <= 0 || format.height <= 0 || playerView.getWidth() <= 0 || playerView.getHeight() <= 0) {
            return 1f;
        }
        float scaleW = playerView.getWidth() / (float) format.width;
        float scaleH = playerView.getHeight() / (float) format.height;
        return Math.max(1f, Math.min(scaleW, scaleH));
    }

    boolean isHdrContent() {
        Format format = selectedVideoFormat();
        ColorInfo colorInfo = format != null ? format.colorInfo : null;
        if (colorInfo == null) return false;
        return colorInfo.colorSpace == C.COLOR_SPACE_BT2020
            || colorInfo.colorTransfer == C.COLOR_TRANSFER_ST2084
            || colorInfo.colorTransfer == C.COLOR_TRANSFER_HLG;
    }

    private void applyZoomTransform(View v) {
        PlayerUiHelper.applyZoomTransform(this, v);
    }

    /* Flips on/off in place, same "toggle IS the persisted setting" model as
       ambient-pipeline.js's setAmbientEnabled on the web leg - written to
       SharedPreferences immediately rather than only a Settings-modal default, since
       there's no per-video override to reconcile it against here. Deliberately does NOT
       touch zoomScale/applyZoomTransform - ambient lighting only fills whatever
       letterbox/pillarbox gap PlayerView's own AspectRatioFrameLayout already leaves
       when the video's aspect ratio doesn't match the screen, it never resizes or zooms
       the picture itself (see layoutGlow's own comment for why that gap needs
       playerView's background made transparent, not shrinking playerView, to actually
       show through). */
    void setAmbientEnabled(boolean enabled) {
        ambientEnabled = enabled;
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putBoolean(PREF_AMBIENT_ENABLED, enabled).apply();
        /* PlayerView paints its own bounds black by default (see the comment on its
           construction in onCreate) - that default has to be overridden every time this
           toggles, not just once at startup, since it's what blocks ambientGlowView
           from showing through PlayerView's own letterbox/pillarbox gap. */
        playerView.setBackgroundColor(enabled ? Color.TRANSPARENT : Color.BLACK);
        Log.d(AMBIENT_TAG, "setAmbientEnabled(" + enabled + ") - playerView background now "
            + (enabled ? "TRANSPARENT" : "BLACK") + ", sampler=" + ambientSampler);
        if (enabled) {
            loggedFirstAmbientLayout = false;
            if (ambientSampler != null) ambientSampler.start();
        } else {
            if (ambientSampler != null) ambientSampler.stop();
            if (ambientGlowView != null) {
                int[] noZones = new int[0];
                ambientGlowView.setColors(noZones, noZones, noZones, noZones);
            }
        }
        layoutGlow();
    }

    /* Same immediate-persistence model as setAmbientEnabled/setShaderStrength above.
       Cheap to apply live (just Paint.setAlpha in AmbientGlowView, no GL program
       rebuild), unlike applyVideoEffects for shader/color-boost strength - see
       openAmbientPanel in PlayerUiHelper for why that one doesn't need to gate to the
       slider's release. */
    void setAmbientOpacity(float opacity) {
        ambientOpacity = opacity;
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putFloat(PREF_AMBIENT_OPACITY, opacity).apply();
        if (ambientGlowView != null) ambientGlowView.setGlowOpacity(opacity);
    }

    /* Same immediate-persistence model as setAmbientEnabled - whatever this is last set
       to (see PlayerUiHelper's Shader Upscaling menu row) is what every subsequent video
       starts from, not a Settings-modal default read from an Intent extra any more (see
       EXTRA_SHADER_TYPE's own comment). shaderType still needs re-resolving here since
       flipping this toggle doesn't touch upscaleStrength - restoring it just restores
       whatever strength the slider was already at. */
    void setShaderEnabled(boolean enabled) {
        shaderEnabled = enabled;
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putBoolean(PREF_UPSCALE_ENABLED, enabled).apply();
        shaderType = resolveShaderType();
        applyVideoEffects();
    }

    /* Same immediate-persistence model as setShaderEnabled above. Gated to
       onStopTrackingTouch by PlayerUiHelper's Shader Upscaling SeekBar, not called at
       drag frequency - applyVideoEffects() rebuilds ExoPlayer's whole video-effects
       pipeline on every call, previously observed to get the renderer stuck when called
       that often (see that panel's own SeekBar listener comment). */
    void setShaderStrength(float strength) {
        upscaleStrength = strength;
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putFloat(PREF_UPSCALE_STRENGTH, strength).apply();
        shaderType = resolveShaderType();
        applyVideoEffects();
    }

    /* Same immediate-persistence model as setShaderEnabled/setShaderStrength above - only
       this on/off flag is written through, never the live-computed autoUpscaleStrength
       itself (see ContentAnalysisSampler). Switching auto off falls back to whatever
       upscaleStrength the slider was last left at, same "toggle overrides, doesn't
       erase" model setShaderEnabled already uses for the shader on/off toggle. */
    void setUpscaleAuto(boolean enabled) {
        upscaleAuto = enabled;
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putBoolean(PREF_UPSCALE_AUTO, enabled).apply();
        shaderType = resolveShaderType();
        updateContentAnalysis();
        applyVideoEffects();
    }

    /* Whether the shader actually renders as OFF can't just check upscaleStrength > 0f -
       in Auto mode the manual slider's position is irrelevant (it isn't applied at all,
       see applyVideoEffects's own resolvedUpscaleStrength), so a manual strength of
       exactly 0 must not force OFF while upscaleAuto is true. Shared by every place that
       can change shaderEnabled, upscaleStrength, or upscaleAuto, so none of them can
       resolve this stale relative to the other two. */
    private ShaderType resolveShaderType() {
        boolean hasStrength = upscaleAuto || upscaleStrength > 0f;
        return shaderEnabled && hasStrength ? detectedShaderType : ShaderType.OFF;
    }

    /* Same "toggle IS the persisted setting" immediate-persistence model as
       setAmbientEnabled above. Unlike ambient opacity, this goes through
       applyVideoEffects() (a GL program rebuild via setVideoEffects()), so
       PlayerUiHelper's Color Boost strength SeekBar gates the actual apply to
       onStopTrackingTouch, same drag-frequency hazard as the Shader Upscaling panel -
       see that panel's own comment. */
    void setColorBoostEnabled(boolean enabled) {
        colorBoostEnabled = enabled;
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putBoolean(PREF_COLOR_BOOST_ENABLED, enabled).apply();
        applyVideoEffects();
    }

    void setColorBoostStrength(float strength) {
        colorBoostStrength = strength;
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putFloat(PREF_COLOR_BOOST_STRENGTH, strength).apply();
        applyVideoEffects();
    }

    /* Same immediate-persistence model as setColorBoostEnabled/setUpscaleAuto above. */
    void setColorBoostAuto(boolean enabled) {
        colorBoostAuto = enabled;
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putBoolean(PREF_COLOR_BOOST_AUTO, enabled).apply();
        updateContentAnalysis();
        applyVideoEffects();
    }

    /* "auto"/"on"/"off" - the three-way state PlayerUiHelper's mode row presents in place
       of the old separate enabled-toggle + Auto-checkbox pair, same collapsing reasoning
       as shader-pipeline.js's upscaleModeOf on the web leg. shaderEnabled/upscaleAuto
       still the two flags applyVideoEffects/persistence actually key off. */
    String upscaleMode() {
        if (!shaderEnabled) return "off";
        return upscaleAuto ? "auto" : "on";
    }

    /* Drives both flags from one selection - "off" and "on" both set upscaleAuto false
       so a later switch straight to "on" (skipping "auto") doesn't inherit a stale auto
       flag from a previous session. */
    void setUpscaleMode(String mode) {
        setShaderEnabled(!"off".equals(mode));
        setUpscaleAuto("auto".equals(mode));
    }

    /* Same collapsing reasoning as upscaleMode/setUpscaleMode above. */
    String colorBoostMode() {
        if (!colorBoostEnabled) return "off";
        return colorBoostAuto ? "auto" : "on";
    }

    void setColorBoostMode(String mode) {
        setColorBoostEnabled(!"off".equals(mode));
        setColorBoostAuto("auto".equals(mode));
    }

    /* Starts/stops the shared content-analysis capture loop based on whether either auto
       mode needs it - mirrors content-analysis.js's updateContentAnalysis on the web leg.
       Called from setUpscaleAuto/setColorBoostAuto above. */
    void updateContentAnalysis() {
        if (contentSampler == null) return;
        if (upscaleAuto || colorBoostAuto) {
            contentSampler.start();
        } else {
            contentSampler.stop();
        }
    }

    /* Same "toggle IS the persisted setting" immediate-persistence model as
       setAmbientEnabled/setColorBoostEnabled above - just a View visibility flip, no GL
       rebuild, so this applies instantly with no drag-frequency concern at all (see
       PlayerUiHelper's Performance Overlay menu row, a plain toggle with no drill-down
       panel - there's no strength to tune here). */
    void setStatsOverlayEnabled(boolean enabled) {
        statsOverlayEnabled = enabled;
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putBoolean(PREF_STATS_OVERLAY_ENABLED, enabled).apply();
        if (statsOverlayText != null) {
            statsOverlayText.setVisibility(enabled ? View.VISIBLE : View.GONE);
        }
        PlayerUiHelper.updateStatsOverlay(this);
    }

    /* Same "toggle IS the persisted setting" immediate-persistence model as
       setStatsOverlayEnabled above - no view to update, just the flag itself, read back
       by the STATE_ENDED handler whenever a title actually finishes. */
    void setAutoPlayEnabled(boolean enabled) {
        autoPlayEnabled = enabled;
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putBoolean(PREF_AUTO_PLAY_ENABLED, enabled).apply();
    }

    /* Same "toggle IS the persisted setting" immediate-persistence model as
       setAutoPlayEnabled above - see PlayerUiHelper's Quality Cap menu (the "Auto" row,
       and each explicit preset row disabling this). */
    void setAutoQualityEnabled(boolean enabled) {
        autoQualityEnabled = enabled;
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putBoolean(PREF_AUTO_QUALITY_ENABLED, enabled).apply();
        updateAbrMonitor();
    }

    /* Starts/stops QualityAbrMonitor's own tick loop based on the persisted toggle -
       mirrors updateContentAnalysis above. Called on construction and every time the
       toggle flips. */
    private void updateAbrMonitor() {
        if (abrMonitor == null) return;
        if (autoQualityEnabled) {
            abrMonitor.start();
        } else {
            abrMonitor.stop();
        }
    }

    /* player.getVideoSize()/onVideoSizeChanged never resolve past 0x0 for the entire
       playback session once applyVideoEffects() has attached any effects list to this
       player - confirmed via logcat on real hardware, even minutes into playback with
       frames clearly decoding. setVideoEffects() (called unconditionally in onCreate,
       even with an empty no-op list per its own javadoc) reroutes ExoPlayer through a
       VideoFrameProcessor/compositing sink, and that path just doesn't feed the
       classic MediaCodecVideoRenderer video-size signal in this Media3 version. Read
       the selected video track's own Format instead - populated straight from the
       parsed container/manifest, independent of whichever rendering path is active. */
    private float resolveVideoAR(float fallback) {
        if (player == null) return fallback;
        VideoSize videoSize = player.getVideoSize();
        if (videoSize.width > 0 && videoSize.height > 0) {
            return (float) videoSize.width / videoSize.height;
        }
        Format format = selectedVideoFormat();
        if (format == null || format.width <= 0 || format.height <= 0) return fallback;
        float ar = (float) format.width / format.height;
        return format.rotationDegrees % 180 != 0 ? 1f / ar : ar;
    }

    /* Mirrors ambient-pipeline.js's computePictureRect on the web leg: where the
       video's actual rendered picture sits within root's own bounds, accounting for
       its own aspect-ratio letterboxing/pillarboxing against the full screen
       (PlayerView's AspectRatioFrameLayout already does the fitting visually - this
       just re-derives the same rect in root's coordinate space so AmbientGlowView's
       four edge gradients can be sized off it, since there's no View API that reports
       the fitted rect back directly). Deliberately measured against root's own full
       bounds, not a shrunk box - ambient lighting only fills the gap the video's own
       aspect ratio already leaves, it doesn't manufacture one by zooming/resizing the
       picture. Safe to call before root has been measured (getWidth()/getHeight()
       report 0 pre-layout) or before the player knows its own video size - both are
       silently skipped/approximated and self-correct on the next call (see this
       method's own callers). */
    private void layoutGlow() {
        if (ambientGlowView == null || root == null) return;
        int vw = root.getWidth();
        int vh = root.getHeight();
        if (vw == 0 || vh == 0) return;

        float screenAR = (float) vw / vh;
        float videoAR = resolveVideoAR(screenAR);

        /* PlayerView's own internal exo_content_frame relies on the same broken
           onVideoSizeChanged/getVideoSize signal (see resolveVideoAR's comment above) to
           decide how big to make the actual SurfaceView. Without this, exo_content_frame
           never shrinks - the SurfaceView stays full-screen, and ExoPlayer's video-effects
           GL pipeline (attached unconditionally by applyVideoEffects) bakes the
           letterbox/pillarbox bars directly into the composited frame instead of leaving a
           real transparent gap in the view hierarchy. Visually indistinguishable from a
           real gap (bars appear in the same place) but AmbientGlowView, sitting behind a
           now fully-opaque full-screen SurfaceView, can never show through it. Forcing the
           same track-format-derived AR onto this frame directly fixes both. */
        if (contentFrame == null) {
            View frame = playerView.findViewById(androidx.media3.ui.R.id.exo_content_frame);
            if (frame instanceof AspectRatioFrameLayout) {
                contentFrame = (AspectRatioFrameLayout) frame;
            }
        }
        if (contentFrame != null) {
            contentFrame.setAspectRatio(videoAR);
        }

        float w;
        float h;
        if (videoAR > screenAR) {
            w = vw;
            h = vw / videoAR;
        } else {
            h = vh;
            w = vh * videoAR;
        }
        float left = (vw - w) / 2f;
        float top = (vh - h) / 2f;
        /* Logged once per enable (see loggedFirstAmbientLayout reset in
           setAmbientEnabled), not every ~42ms call - confirms the gap this method
           computed actually has nonzero size. A picture rect equal to the full
           root bounds (0,0,vw,vh) means videoAR came out equal to screenAR - i.e. no
           letterbox gap exists for this content on this device, so there is nothing
           for the glow to show regardless of anything else working correctly. */
        if (!loggedFirstAmbientLayout) {
            loggedFirstAmbientLayout = true;
            Log.d(AMBIENT_TAG, "layoutGlow - root=" + vw + "x" + vh + " videoAR=" + videoAR
                + " screenAR=" + screenAR + " pictureRect=[" + left + "," + top + "," + (left + w) + "," + (top + h) + "]");
        }
        ambientGlowView.setPictureRect(left, top, left + w, top + h);
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
        /* Piggybacks on this existing ~1s tick rather than its own timer - a debug
           readout doesn't need faster-than-1s refresh, and this is already the
           established "periodic, not per-frame" cadence for anything that doesn't
           (contrast AmbientLightSampler's own faster ~42ms tick, which does). No-ops
           internally when the overlay isn't toggled on. */
        PlayerUiHelper.updateStatsOverlay(this);
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

    /* Called from PlayerUiHelper's title-nav button click handler, already on the UI
       thread - unlike showSkipButton/hideSkipButton above (invoked from a Capacitor
       plugin call, not guaranteed to arrive on it), there's no thread hop to make here. */
    static void requestTitleNav(int newIndex) {
        if (listener != null) {
            listener.onTitleNavRequested(newIndex);
        }
    }

    /* Called from PlayerUiHelper's Episodes button click handler, already on the UI
       thread - same "no thread hop needed" reasoning as requestTitleNav above. JS has no
       episode data to send back yet at this point (see showEpisodeList below, arriving
       asynchronously once JS resolves the Plex fetch) - this only reports that the user
       asked to see the queue. */
    static void requestEpisodeList() {
        if (listener != null) {
            listener.onEpisodeListRequested();
        }
    }

    /* Bridge entry point for NativePlayerPlugin.showEpisodeList - the asynchronous
       response to requestEpisodeList above. Same runOnUiThread reasoning as loadTitle
       below: a Capacitor plugin call isn't guaranteed to arrive on the UI thread, and
       this ends up building/showing a PopupWindow (see PlayerUiHelper.openEpisodeListMenu). */
    public static void showEpisodeList(String episodesJson) {
        if (activeInstance != null) {
            activeInstance.runOnUiThread(() -> activeInstance.showEpisodeListInternal(episodesJson));
        }
    }

    private void showEpisodeListInternal(String episodesJson) {
        List<EpisodeEntry> episodes = parseEpisodeList(episodesJson);
        if (!episodes.isEmpty()) {
            PlayerUiHelper.openEpisodeListMenu(this, episodes);
        } else {
            /* Otherwise the loading placeholder shown on tap (see
               PlayerUiHelper.showEpisodeListLoading) would just spin forever - an empty
               result means the fetch resolved but found nothing (or failed) rather than
               never resolving, so this is reachable, not just defensive. */
            PlayerUiHelper.closeEpisodeListMenu(this);
        }
    }

    /* Same org.json.JSONArray/optString parsing idiom as parseChapters/parseAudioStreams
       below - the queue's Plex metadata is already resolved and formatted in JS
       (episode-list.js's formatEpisodeListItem), this just rebuilds it into Java objects. */
    private static List<EpisodeEntry> parseEpisodeList(String json) {
        List<EpisodeEntry> episodes = new ArrayList<>();
        if (json == null) return episodes;
        try {
            org.json.JSONArray arr = new org.json.JSONArray(json);
            for (int i = 0; i < arr.length(); i++) {
                org.json.JSONObject obj = arr.getJSONObject(i);
                String thumbUrl = obj.has("thumbUrl") && !obj.isNull("thumbUrl") ? obj.optString("thumbUrl", null) : null;
                episodes.add(new EpisodeEntry(
                    obj.optInt("index", -1),
                    obj.optInt("queueIndex", -1),
                    obj.optString("ratingKey", ""),
                    obj.optString("title", ""),
                    obj.optString("subtitle", ""),
                    obj.optString("summary", ""),
                    thumbUrl,
                    (float) obj.optDouble("progress", 0),
                    obj.optBoolean("watched", false),
                    obj.optBoolean("current", false)));
            }
        } catch (org.json.JSONException e) {
            // malformed episode-list data - show nothing rather than crash
        }
        return episodes;
    }

    /* Bridge entry point for NativePlayerPlugin.switchTitle - unlike play()/the Intent-
       based cold start, this never launches a new Activity, so there's no
       startActivityForResult/onPlaybackActivityResult round trip to resolve against; the
       plugin call resolves as soon as this returns. runOnUiThread since, like
       showSkipButton/hideSkipButton, a Capacitor plugin call isn't guaranteed to arrive
       on the UI thread and applyTitleSwitch mutates views (rebuilds the transport bar/
       floating controls) as well as calling into ExoPlayer. */
    public static void loadTitle(String url, long startPositionMs, String shaderType, String title,
            String episodeTitle, Integer year, Integer seasonNumber, Integer episodeNumber,
            Integer queueLength, Integer queueIndex, String chaptersJson, String bifUrl, String audioStreamsJson,
            String mediaVersionsJson, Integer currentMediaIndex, Integer qualityCapKbps) {
        if (activeInstance != null) {
            activeInstance.runOnUiThread(() -> activeInstance.applyTitleSwitch(url, startPositionMs, shaderType,
                title, episodeTitle, year, seasonNumber, episodeNumber, queueLength, queueIndex,
                chaptersJson, bifUrl, audioStreamsJson, mediaVersionsJson, currentMediaIndex, qualityCapKbps));
        }
    }

    /* Swaps the currently playing title in place - same Activity instance, same
       ExoPlayer, same ambient/shader GL pipeline - instead of finish()-ing and letting
       NativePlayerPlugin.play() relaunch a fresh PlayerActivity for the next title. That
       relaunch is what used to make title-prev/title-next (both the on-screen buttons
       and the swipe gesture, see PlayerUiHelper.seekToAdjacentTitle) visibly swipe the
       whole window out and back in for what should read as one continuous player.
       Mirrors the per-title subset of onCreate's own setup - everything NOT tied to the
       Activity/PlayerView/ExoPlayer instance itself (which onCreate builds once and this
       reuses unchanged). */
    void applyTitleSwitch(String url, long startPositionMs, String shaderTypeName, String newTitle,
            String newEpisodeTitle, Integer newYear, Integer newSeasonNumber, Integer newEpisodeNumber,
            Integer newQueueLength, Integer newQueueIndex, String chaptersJson, String bifUrl, String audioStreamsJson,
            String mediaVersionsJson, Integer newCurrentMediaIndex, Integer newQualityCapKbps) {
        if (player == null) return;

        if (menuPopup != null) {
            menuPopup.dismiss();
            menuPopup = null;
        }
        PlayerUiHelper.closeEpisodeListMenu(this);
        hideSkipButtonInternal();
        zoomScale = 1f;
        panX = 0f;
        panY = 0f;
        applyZoomTransform(playerView);
        /* This title's own terminal state (ended/error/stopped), not the session as a
           whole - a fresh title starting playback hasn't hit any of those yet. */
        terminalStateReported = false;

        /* Ambient lighting otherwise keeps showing the outgoing title's last-sampled
           colors on screen for as long as the new title takes to buffer its first real
           frame, then slowly eases (via AmbientLightSampler's own EMA smoothing) from
           that stale color into the new one - reading as an unwanted lingering fade
           rather than an instant switch. Clearing the glow view's own displayed colors
           right away, on top of resetSmoothing() below, makes the switch itself instant;
           resetSmoothing() is what keeps the *next* real sample from re-fading back in
           from zero once it arrives. */
        if (ambientGlowView != null) {
            int[] noZones = new int[0];
            ambientGlowView.setColors(noZones, noZones, noZones, noZones);
        }
        if (ambientSampler != null) {
            ambientSampler.resetSmoothing();
        }

        parseChapters(chaptersJson);
        parseAudioStreams(audioStreamsJson);
        parseMediaVersions(mediaVersionsJson);
        currentMediaIndex = newCurrentMediaIndex != null ? newCurrentMediaIndex : 0;
        qualityCapKbps = newQualityCapKbps;
        bifIndex = null;
        if (bifUrl != null && !bifUrl.isEmpty()) {
            BifIndex.load(bifUrl, index -> bifIndex = index);
        }
        detectedShaderType = parseShaderType(shaderTypeName);
        shaderType = resolveShaderType();

        title = newTitle != null ? newTitle : "";
        episodeTitle = newEpisodeTitle != null ? newEpisodeTitle : "";
        year = newYear != null ? newYear : -1;
        seasonNumber = newSeasonNumber != null ? newSeasonNumber : -1;
        episodeNumber = newEpisodeNumber != null ? newEpisodeNumber : -1;
        queueLength = newQueueLength != null ? newQueueLength : 0;
        queueIndex = newQueueIndex != null ? newQueueIndex : -1;

        /* Rebuilt wholesale rather than mutated in place - their per-title state (title/
           subtitle text, chapter-skip button visibility, next-title-enabled) is exactly
           what PlayerUiHelper's own builder methods already compute from the fields just
           set above, so reusing them here is cheaper and less error-prone than a second,
           partial "update in place" code path that could drift from onCreate's. */
        float density = getResources().getDisplayMetrics().density;
        if (transportBarView != null) {
            root.removeView(transportBarView);
            fadingControls.remove(transportBarView);
        }
        if (floatingControlsView != null) {
            root.removeView(floatingControlsView);
            fadingControls.remove(floatingControlsView);
        }
        buildTransportBar(density);
        PlayerUiHelper.buildFloatingPlaybackControls(this, density);

        /* The outgoing title's HLS segment loader is very likely still mid-fetch at the
           exact moment a title switch lands (the user can tap next/prev at any point in
           playback, not just at a segment boundary). Confirmed on a real device that
           reusing this same ExoPlayer instance across a switch - whether via stop()+
           setMediaItem()+prepare(), with or without a setVideoEffects() call anywhere in
           that sequence - leaves it wedged in STATE_BUFFERING forever, with no manifest
           request for the new title ever going out and no error callback either.
           createPlayer() releases this instance and builds a fresh one instead (same
           playerView/surface, ambientSampler/contentSampler, and shader pipeline - see
           its own header comment for why those are untouched by this), sidestepping
           whatever internal state that reuse was tripping over. */
        createPlayer();
        if (abrMonitor != null) abrMonitor.notifyReload();
        currentUrl = url;
        MediaItem mediaItem = MediaItem.fromUri(Uri.parse(url));
        player.setMediaItem(mediaItem);
        if (startPositionMs > 0) {
            player.seekTo(startPositionMs);
        }
        player.setPlayWhenReady(true);
        player.prepare();

        showControlsTemporarily();
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
        if (abrMonitor != null) abrMonitor.notifyReload();
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
        currentAudioStreamId = streamId;
        MediaItem newItem = new MediaItem.Builder().setUri(Uri.parse(currentUrl)).build();
        player.setMediaItem(newItem, resumeMs);
        player.prepare();
        if (abrMonitor != null) abrMonitor.notifyReload();
    }

    /* Same "rebuild the transcode URL, resume in place" mechanism as switchAudioStream
       above - Plex bakes the selected Media[] entry into the transcode at session
       start via the mediaIndex param, so switching versions means re-requesting the
       same path with a new one, a fresh session id, and an offset resuming where
       playback left off. Called from PlayerUiHelper's Video Quality > Version menu. */
    void switchMediaVersion(int mediaIndex) {
        if (player == null || currentUrl == null) return;
        long resumeMs = player.getCurrentPosition();
        Uri oldUri = Uri.parse(currentUrl);
        Uri.Builder builder = oldUri.buildUpon().clearQuery();
        for (String name : oldUri.getQueryParameterNames()) {
            if (name.equals("mediaIndex") || name.equals("offset") || name.equals("session")) continue;
            for (String value : oldUri.getQueryParameters(name)) {
                builder.appendQueryParameter(name, value);
            }
        }
        builder.appendQueryParameter("mediaIndex", String.valueOf(mediaIndex));
        builder.appendQueryParameter("offset", String.valueOf(resumeMs / 1000));
        builder.appendQueryParameter("session", java.util.UUID.randomUUID().toString());
        currentUrl = builder.build().toString();
        currentMediaIndex = mediaIndex;
        MediaItem newItem = new MediaItem.Builder().setUri(Uri.parse(currentUrl)).build();
        player.setMediaItem(newItem, resumeMs);
        player.prepare();
        if (abrMonitor != null) abrMonitor.notifyReload();
    }

    /* Same mechanism again for the bitrate cap (Plex's maxVideoBitrate param) - a null
       kbps (Quality Cap's "Original" option) means the param is dropped entirely
       rather than sent as some sentinel value, matching stream-url.js's
       buildStreamUrl on the web leg. Called from PlayerUiHelper's Video Quality >
       Quality Cap menu. */
    void switchQualityCap(Integer kbps) {
        if (player == null || currentUrl == null) return;
        long resumeMs = player.getCurrentPosition();
        Uri oldUri = Uri.parse(currentUrl);
        Uri.Builder builder = oldUri.buildUpon().clearQuery();
        for (String name : oldUri.getQueryParameterNames()) {
            if (name.equals("maxVideoBitrate") || name.equals("offset") || name.equals("session")) continue;
            for (String value : oldUri.getQueryParameters(name)) {
                builder.appendQueryParameter(name, value);
            }
        }
        if (kbps != null) builder.appendQueryParameter("maxVideoBitrate", String.valueOf(kbps));
        builder.appendQueryParameter("offset", String.valueOf(resumeMs / 1000));
        builder.appendQueryParameter("session", java.util.UUID.randomUUID().toString());
        currentUrl = builder.build().toString();
        qualityCapKbps = kbps;
        MediaItem newItem = new MediaItem.Builder().setUri(Uri.parse(currentUrl)).build();
        player.setMediaItem(newItem, resumeMs);
        player.prepare();
        if (abrMonitor != null) abrMonitor.notifyReload();
    }

    public static void stopPlayback() {
        if (activeInstance != null) {
            /* Suppress onDestroy()'s reportStoppedIfNeeded() below, same
               terminal-state-before-finish() pattern notifyErrorAndFinish/the
               STATE_ENDED handler already use - a JS-initiated stop already knows it
               stopped this activity, so a redundant "stopped" event firing later during
               async destruction is at best a no-op (nothing's listening any more, see
               native-bridge.js's stopNative) and at worst - since the prev/next title
               feature re-registers a fresh "stopped" listener for the NEXT title
               immediately after removing this one - lands on that new listener instead
               and gets misread as the next title's own unexpected stop, closing the
               whole player. onActivityResult (see NativePlayerPlugin.onPlaybackActivityResult)
               still fires the same regardless; only the PlaybackListener notification is
               suppressed here. */
            activeInstance.terminalStateReported = true;
            activeInstance.finish();
        }
    }

    /* Toggled by the lock button (locked=true) and the lock overlay's own long-press
       gesture (locked=false) - see PlayerUiHelper.buildLockButton/buildLockOverlay.
       Locking forces every fading control (including the lock button itself) hidden via
       the same setControlsVisible lockstep-fade the inactivity timer uses, then reveals
       the overlay on top of everything to intercept all further touches; unlocking
       reverses both and briefly reveals the chrome again, same as any other action that
       calls showControlsTemporarily. */
    void setTouchLocked(boolean locked) {
        if (touchLocked == locked) return;
        touchLocked = locked;
        if (locked) {
            controlsFadeHandler.removeCallbacks(controlsFadeRunnable);
            setControlsVisible(false);
            if (lockOverlay != null) lockOverlay.setVisibility(View.VISIBLE);
        } else {
            lockMessageHandler.removeCallbacks(hideLockMessageRunnable);
            if (lockMessageView != null) lockMessageView.setVisibility(View.GONE);
            if (lockOverlay != null) lockOverlay.setVisibility(View.GONE);
            showControlsTemporarily();
        }
    }

    /* Called from the lock overlay's onSingleTapConfirmed - re-shown (timer restarted)
       on every tap rather than left to run out from the first one, so repeated taps keep
       the hint up instead of it flickering off mid-read. */
    void showLockMessage() {
        if (lockMessageView == null) return;
        lockMessageView.setVisibility(View.VISIBLE);
        lockMessageHandler.removeCallbacks(hideLockMessageRunnable);
        lockMessageHandler.postDelayed(hideLockMessageRunnable, LOCK_MESSAGE_HIDE_DELAY_MS);
    }

    @Override
    public void onBackPressed() {
        /* Touch is locked specifically so an in-pocket/accidental press can't do
           anything - the back button (itself a touch/soft-nav-bar target) is no
           exception, same as every other control the lock overlay already sits on top
           of and intercepts. */
        if (touchLocked) return;
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
        if (ambientSampler != null) {
            ambientSampler.stop();
        }
        if (contentSampler != null) {
            contentSampler.stop();
        }
        if (abrMonitor != null) {
            abrMonitor.stop();
        }
        sleepTimerHandler.removeCallbacksAndMessages(null);
        controlsFadeHandler.removeCallbacksAndMessages(null);
        lockMessageHandler.removeCallbacksAndMessages(null);
        if (menuPopup != null) {
            menuPopup.dismiss();
            menuPopup = null;
        }
        PlayerUiHelper.closeEpisodeListMenu(this);
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
