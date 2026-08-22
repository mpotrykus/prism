package com.mpotrykus.prism;

import android.app.PictureInPictureParams;
import android.content.Context;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.Rational;
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
import androidx.media3.common.TrackGroup;
import androidx.media3.common.TrackSelectionOverride;
import androidx.media3.common.Tracks;
import androidx.media3.common.VideoSize;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.analytics.AnalyticsListener;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.source.LoadEventInfo;
import androidx.media3.exoplayer.source.MediaLoadData;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;
import java.io.IOException;
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
    /* The Part id backing EXTRA_AUDIO_STREAMS_JSON above - see switchAudioStream's own
       comment for why this is needed to actually apply a track switch. */
    public static final String EXTRA_PART_ID = "partId";
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
       state (see PREF_COLOR_BOOST_SATURATION_ENABLED and friends), same immediate-persistence
       model as colorBoostSaturationEnabled/colorBoostSaturationStrength/colorBoostSaturationAuto
       and the Contrast equivalents, since there's no JS Settings-modal counterpart to seed a
       per-video default from any more. */
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
    /* Matches plex-player.js's own TIMELINE_PING_MS cadence - kept as a separate literal
       here rather than shared, same "no cross-platform protocol constant" shape as every
       other Plex URL param this file already builds independently of the JS leg. */
    private static final long NATIVE_TIMELINE_PING_MS = 10000L;
    private long lastNativeTimelinePingAt = 0L;
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
    private static final String PREFS_NAME = "prism_player_prefs";
    private static final String PREF_AMBIENT_ENABLED = "ambient_lighting_enabled";
    private static final String PREF_AMBIENT_OPACITY = "ambient_lighting_opacity";
    private static final String PREF_UPSCALE_ENABLED = "upscale_enabled";
    private static final String PREF_UPSCALE_STRENGTH = "upscale_strength";
    private static final String PREF_UPSCALE_AUTO = "upscale_auto";
    private static final String PREF_AI_UPSCALING_ENABLED = "ai_upscaling_enabled";
    private static final String PREF_COLOR_BOOST_SATURATION_ENABLED = "color_boost_saturation_enabled";
    private static final String PREF_COLOR_BOOST_CONTRAST_ENABLED = "color_boost_contrast_enabled";
    private static final String PREF_COLOR_BOOST_SATURATION_STRENGTH = "color_boost_saturation_strength";
    private static final String PREF_COLOR_BOOST_CONTRAST_STRENGTH = "color_boost_contrast_strength";
    private static final String PREF_COLOR_BOOST_SATURATION_AUTO = "color_boost_saturation_auto";
    private static final String PREF_COLOR_BOOST_CONTRAST_AUTO = "color_boost_contrast_auto";
    private static final String PREF_STATS_OVERLAY_ENABLED = "stats_overlay_enabled";
    private static final String PREF_AUTO_PLAY_ENABLED = "auto_play_enabled";
    private static final String PREF_AUTO_QUALITY_ENABLED = "auto_quality_enabled";
    private static final String PREF_AUDIO_LEVELING_ENABLED = "audio_leveling_enabled";
    private static final String PREF_AUTO_SKIP_INTRO_CREDITS = "auto_skip_intro_credits_enabled";

    public interface PlaybackListener {
        void onProgress(long positionMs, long durationMs);
        void onEnded();
        void onError(String message);
        void onStopped(long positionMs);
        void onTitleNavRequested(int newIndex);
        void onEpisodeListRequested();
        void onSubtitleSearchRequested(String query);
        void onSubtitleSelectRequested(String fileId, String label, String languageCode);
        void onSubtitleCleared();
        void onSubtitleOffsetChanged(long offsetMs);
        /* Fired instead of this class's own query-param URL surgery (see
           switchQualityCap/switchMediaVersion/switchAudioStreamViaRestart) when
           currentUrl is a real direct-play file URL, not a transcode URL - there's no
           transcode-shaped query param to rewrite, so JS has to resolve a real new URL
           (via stream-url.js's resolvePlaybackUrl, the same decision-aware logic every
           other platform's reload already goes through) and hand it back via
           NativePlayer.applyReloadedUrl. See native-bridge.js's own listener for this
           event and NativePlayerPlugin.applyReloadedUrl for the reply leg. */
        void onDirectPlayReloadRequested(String kind, String value, long resumeMs, long generation);
        /* Fired whenever either flag changes via the More menu's Auto-Play/Auto-Skip
           Intro & Credits rows (setAutoPlayEnabled/setAutoSkipIntroCreditsEnabled below) -
           native-bridge.js's own progress listener keeps a local mirror of both so its
           marker/countdown decision (there's no JS chrome for a menu toggle to reach
           into on this platform - see that file's own comment) stays correct without
           re-querying getAutoSkipSettings on every tick. */
        void onAutoSkipSettingsChanged(boolean autoPlayEnabled, boolean autoSkipIntroCreditsEnabled);
    }

    private static PlaybackListener listener;
    private static PlayerActivity activeInstance;
    private boolean isCurrentlyPip;

    public static void setListener(PlaybackListener l) {
        listener = l;
    }

    /* MainActivity's onResume checks this to immediately moveTaskToBack itself rather
       than staying visible - otherwise Android's documented "activity below a PiP window
       becomes resumed and interactable" behavior (developer.android.com/develop/ui/views/
       picture-in-picture) would let the browsing UI show/act as a separate surface behind
       the floating player, which is exactly what PiP mode here is meant to prevent.

       Deliberately NOT based on isCurrentlyPip/onPictureInPictureModeChanged - confirmed
       via logcat (device: SM_X710) that callback fires AFTER MainActivity.onResume() on
       real hardware, not before, so a flag set from it always reads stale here. isFinishing()
       is set synchronously by finish()/onBackPressed() before onPause() runs, and MainActivity
       only ever gets resumed out from under the player in the two cases: (1) it's genuinely
       exiting (isFinishing() true - let MainActivity show normally), or (2) it just got
       reparented into PiP's own task and paused in place (isFinishing() false - bounce
       MainActivity back). */
    static boolean isActiveAndNotFinishing() {
        return activeInstance != null && !activeInstance.isFinishing();
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
    /* "fit"/"cover"/"stretch" - see PlayerUiHelper's Aspect row (renderOptionsList) and
       applyAspectMode below. Independent of zoomScale/panX/panY above: that's a separate,
       continuous pinch/pan gesture on the video surface, not a picker in the menu. */
    String aspectMode = "fit";
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
    /* Same immediate-persistence model as ambientEnabled/colorBoostSaturationEnabled below -
       see setShaderStrength/setShaderEnabled. No JS Settings-modal default any more (unlike
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
    /* The real Anime4K CNN / FSR 1 chain (see AiUpscalingPresets/AiUpscaleEffect) - independent
       of shaderEnabled/shaderType (Sharpening) and colorBoost*Enabled, matching the web leg's
       split (see shaders.js's "AI Upscaling split from Sharpening" note). Defaults off like
       every other quality-toggle here - opt-in for a never-touched user. */
    boolean aiUpscalingEnabled = false;
    /* Set by AiUpscaleEffect.toGlShaderProgram right after construction, read by
       PlayerUiHelper's stats overlay for the "AI Upscaling" status line - see
       AiUpscaleShaderProgram.statusLabel(). Not cleared on release(); a briefly-stale read on a
       cosmetic debug overlay is an acceptable trade for not needing a listener interface here. */
    AiUpscaleShaderProgram activeAiUpscaleProgram;
    /* Ambient lighting has no per-video/genre concern to resolve on this leg, so its
       persisted default lives entirely in this Activity's own SharedPreferences (see
       PREFS_NAME/PREF_AMBIENT_ENABLED), read once in onCreate and written back whenever
       the gear-menu toggle flips (see setAmbientEnabled). */
    boolean ambientEnabled = false;
    /* Same immediate-persistence model as ambientEnabled above - see setAmbientOpacity. */
    float ambientOpacity = 0.5f;
    /* Contrast/saturation "look" boost - same immediate-persistence model as ambient
       lighting above (no per-video/genre concern of its own either), but independent of
       shaderType/shaderEnabled/upscaleStrength above: see AiUpscaleShaderProgram's own
       header comment for how the two toggles now share one GL pass. Saturation and
       Contrast are fully independent controls now - each its own enabled/auto pair, each
       its own Auto|On|Off mode (see PlayerUiHelper's two independent mode rows and
       ColorBoostTuning.at) - not one shared toggle, since a viewer may want one boosted
       and not the other. Auto also derives from a different signal per component now
       (avgSaturation for Saturation, lumaStdDev for Contrast - see AutoStrength's
       colorBoost/colorBoostContrast), not one shared auto-resolved value. */
    boolean colorBoostSaturationEnabled = false;
    boolean colorBoostContrastEnabled = false;
    float colorBoostSaturationStrength = 0.5f;
    float colorBoostContrastStrength = 0.5f;
    /* Same immediate-persistence model as colorBoostSaturationEnabled/upscaleAuto above -
       live-computed strength itself is never persisted, only this flag - see
       setColorBoostSaturationAuto/setColorBoostContrastAuto. */
    boolean colorBoostSaturationAuto = false;
    boolean colorBoostContrastAuto = false;
    float autoColorBoostSaturationStrength = 0.5f;
    float autoColorBoostContrastStrength = 0.5f;
    /* Same immediate-persistence model as ambientEnabled/colorBoostSaturationEnabled above -
       a debug readout has no per-video/genre concern to reconcile either. Read view, not
       player state - see PlayerUiHelper.buildStatsOverlay/updateStatsOverlay. */
    boolean statsOverlayEnabled = false;
    /* No per-video/genre concern to resolve (see AudioLevelingProcessor). Unlike every
       other toggle here, the actual install target is a native AudioProcessor rebuilt
       fresh every createPlayer() call (see that method) rather than a View/GL pipeline
       this Activity owns directly - audioLevelingProcessor below is that instance,
       re-created and re-applied to this flag each time. Defaults to true - see
       shared.js's storedAudioLevelingEnabled for why. */
    boolean audioLevelingEnabled = true;
    AudioLevelingProcessor audioLevelingProcessor;
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
    /* Defaults OFF for a never-touched user - see shared.js's storedAutoSkipIntroCreditsEnabled.
       Gated on autoPlayEnabled (see PlayerUiHelper's menu row) since an auto-skipped credits
       marker only makes sense as part of "keep watching automatically" - same reasoning
       chrome-skip.js's shouldAutoSkip uses on web/Xbox. */
    boolean autoSkipIntroCreditsEnabled = false;
    QualityAbrMonitor abrMonitor;
    /* A fresh player's own initial buffering (before the first STATE_READY) isn't a real
       stall - reset to false at the top of createPlayer() so the ABR monitor's
       notifyStall isn't fed a false positive on cold start or right after a title
       switch/quality-cap reload, all of which rebuild the player from scratch. */
    boolean everStartedPlaying = false;
    /* Guards applyVideoEffects()'s ONE real player.setVideoEffects() install for this player
       instance - see that method's own header comment for why every later toggle must never
       call it again. Reset alongside everStartedPlaying at the top of createPlayer(). */
    boolean effectsInstalled = false;
    /* HDR-ness can only be answered once a real track is selected (see isHdrContent()'s own
       callers) - this flags the FIRST applyVideoEffects() call that has real track info, which
       is the one and only moment the empty-vs-installed decision gets made for this player
       instance. Every applyVideoEffects() call before that (the mandatory pre-prepare() one)
       necessarily sees hdr=false (no track yet) and installs optimistically; this flag is what
       lets the first real answer still correct that if the title turns out to actually be HDR. */
    boolean hdrDecided = false;
    TextView statsOverlayText;
    PlayerView playerView;
    AmbientGlowView ambientGlowView;
    private AmbientLightSampler ambientSampler;
    private boolean loggedFirstAmbientLayout = false;
    private ContentAnalysisSampler contentSampler;
    int sleepMinutes = 0;
    /* Bumped by every switchAudioStreamViaRestart/switchMediaVersion/switchQualityCap
       call, captured by each call's own async decision-then-apply pipeline before it
       does any network work - confirmed via a real device's logcat that these can
       genuinely race: the ABR monitor's own autonomous switchQualityCap can fire while
       a manual audio switch's decision request is still in flight, and since both are
       now async (see askDecision's own header comment for why they have to be), whichever
       one's apply() Runnable reaches the main thread LAST used to win regardless of which
       one was actually requested most recently - observed as two /start.m3u8 requests
       firing 34ms apart for what should have been a single switch, and a manual switch
       to Japanese silently reverting back to English because a slightly-earlier,
       slower-to-resolve ABR quality reload (which always carries the CURRENT
       audioStreamID forward unchanged) applied its own MediaItem afterward. Each
       apply() Runnable checks its own captured generation against this field before
       touching player/currentUrl, so a superseded reload's result is simply discarded
       once a newer one has already been requested, instead of racing to overwrite it. */
    private long reloadGeneration = 0;
    /* Serializes switchAudioStreamViaRestart/applyReloadedUrlAfterDecision's own network
       work (PUT/stop/decision/start) so at most one is ever in flight against Plex at a
       time - reloadGeneration above only controls which one's RESULT the client ends up
       playing, it does nothing to stop both from actually being sent. Confirmed against
       a real server this matters on its own, independent of the client-side race: two
       /start requests for the same source landing within tens of milliseconds of each
       other (a manual audio switch racing the ABR monitor's own autonomous quality
       reload) left the server itself transcoding the wrong audio for the session the
       client kept, even once reloadGeneration correctly discarded the losing response -
       reproduced with plain sequential curl requests (no overlap) instead reliably
       honoring the switch every time. runSerializedReload queues at most one pending
       reload behind whichever is currently in flight, coalescing multiple rapid
       requests down to just the latest rather than letting any of them overlap on the
       wire. */
    private boolean reloadInFlight = false;
    private Runnable queuedReload = null;
    String currentAudioStreamId;
    /* Nullable - a title with no Part.Stream data at all (see title-info.js's
       extractPartId) just leaves switchAudioStream unable to actually apply a
       selection, same "no data, no-op" handling as an empty audioStreams list. */
    String partId;
    /* The More options bottom sheet (see PlayerUiHelper.showPlayerMenu/closePlayerMenu) -
       tracked here, not just a PlayerUiHelper-local variable, since PlayerActivity.
       onDestroy needs a way to know none is leaked, the same "shared session state lives
       on the activity" reasoning every other package-private field here follows. Added
       directly into root rather than a PopupWindow - same edge-to-edge cutout-clipping
       reasoning as episodeListScrim/episodeListSheet below (confirmed via dumpsys window
       that a full-width PopupWindow's frame gets clipped to the display's cutout-safe
       area even though the Activity's own window renders edge-to-edge, with no public
       PopupWindow API to opt out of that). */
    View menuScrim;
    View menuSheet;
    /* The Episodes bottom sheet (see PlayerUiHelper.openEpisodeListMenu/closeEpisodeListMenu) -
       same "added straight into root" reasoning as menuScrim/menuSheet above. */
    View episodeListScrim;
    View episodeListSheet;
    /* The Chapters bottom sheet (see PlayerUiHelper.openChapterListMenu/closeChapterListMenu) -
       same shape/reasoning as episodeListScrim/episodeListSheet above, just for
       activity.chapters instead of a fetched episode queue. */
    View chapterListScrim;
    View chapterListSheet;
    /* The merged Audio & Subtitles dialog (see PlayerUiHelper.openAudioSubtitlesMenu/
       closeAudioSubtitlesMenu) - same "added straight into root" reasoning as
       menuScrim/menuSheet above, just wider (its two side-by-side columns need more
       room than the More sheet's own capped width). */
    View audioSubtitlesScrim;
    View audioSubtitlesSheet;
    /* Populated by PlayerActivity.showSubtitleResults once JS resolves a Plex subtitle
       search (plex-subtitles.js's search(), shared with the web overlay) - Java never
       calls the Plex subtitle endpoints directly, same "JS interprets the external
       protocol once" split chapters/audioStreams already use. currentSubtitleFileId
       null means "Off" (no sidecar track attached) - there's no server-side "current
       subtitle" the way currentAudioStreamId has, since the fetched subtitle text is
       attached client-side, not part of the Plex transcode session at all.
       subtitlePendingFileId/
       subtitleApplyErrorFileId/Message track the in-flight or just-failed selection so
       PlayerUiHelper.refreshAudioSubtitlesMenu can show "Applying…"/an inline error on
       the one row that needs it, without threading a mutable TextView reference through
       the native<->JS round trip. */
    final List<SubtitleResultEntry> subtitleResults = new ArrayList<>();
    String currentSubtitleFileId;
    String currentSubtitleLabel;
    String subtitlePendingFileId;
    String subtitleApplyErrorFileId;
    String subtitleApplyErrorMessage;
    /* The actual sidecar track state, as opposed to currentSubtitleFileId/Label above
       (Plex-subtitle-search-result bookkeeping for the menu UI). currentSubtitleUri is
       what's actually fed to MediaItem.SubtitleConfiguration - needed as its own field
       (not just re-derived from currentSubtitleSrtText each time) because
       switchAudioStream/switchMediaVersion/switchQualityCap each rebuild the MediaItem
       from scratch for their own reasons (a new audioStreamID/mediaIndex/maxVideoBitrate
       baked into the transcode URL) and, without carrying this forward, silently dropped
       whatever subtitle was active - confirmed against a real device: the auto-quality
       ABR monitor can call switchQualityCap on its own, an arbitrary amount of time after
       a subtitle was applied with no user action in between, wiping it out with no
       visible error. currentSubtitleSrtText/OffsetMs exist so the Sync +/- control
       (writeSubtitleCacheFile/adjustSubtitleOffset below) can re-shift and rewrite the
       on-disk file without re-hitting Plex for every click - mirrors the web
       leg's own Sync control (chrome.js's adjustSubtitleOffset), which can mutate
       already-parsed VTTCue objects directly instead of a source file. */
    private String currentSubtitleSrtText;
    private long currentSubtitleOffsetMs;
    private Uri currentSubtitleUri;
    private String currentSubtitleLanguageCode;
    private String currentSubtitleMimeType;
    /* Last submitted search box text, kept separate from `title` so a rebuild of the
       overlay (any refreshAudioSubtitlesMenu call) reflects what the user actually
       searched for rather than snapping back to the title default - null until the
       first search. */
    String subtitleSearchQueryText;
    String subtitleSearchStatus = "idle";
    String subtitleSearchError;
    final Handler controlsFadeHandler = new Handler(Looper.getMainLooper());
    final Runnable controlsFadeRunnable = () -> setControlsVisible(false);
    boolean controlsVisible = true;
    /* Touch-only lock (see the hasTouchscreen gate at buildLockOverlay's onCreate call
       site, and PlayerUiHelper.showPlayerMenu's "Lock" row for how it's triggered) - see
       setTouchLocked for what actually toggles. */
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
        partId = getIntent().getStringExtra(EXTRA_PART_ID);
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
        aiUpscalingEnabled = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getBoolean(PREF_AI_UPSCALING_ENABLED, false);
        ambientEnabled = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getBoolean(PREF_AMBIENT_ENABLED, false);
        ambientOpacity = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getFloat(PREF_AMBIENT_OPACITY, 0.5f);
        colorBoostSaturationEnabled = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getBoolean(PREF_COLOR_BOOST_SATURATION_ENABLED, false);
        colorBoostContrastEnabled = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getBoolean(PREF_COLOR_BOOST_CONTRAST_ENABLED, false);
        colorBoostSaturationStrength = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getFloat(PREF_COLOR_BOOST_SATURATION_STRENGTH, 0.5f);
        colorBoostContrastStrength = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getFloat(PREF_COLOR_BOOST_CONTRAST_STRENGTH, 0.5f);
        colorBoostSaturationAuto = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getBoolean(PREF_COLOR_BOOST_SATURATION_AUTO, false);
        colorBoostContrastAuto = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getBoolean(PREF_COLOR_BOOST_CONTRAST_AUTO, false);
        statsOverlayEnabled = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getBoolean(PREF_STATS_OVERLAY_ENABLED, false);
        /* Defaults to on - see shared.js's storedAudioLevelingEnabled for why. */
        audioLevelingEnabled = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getBoolean(PREF_AUDIO_LEVELING_ENABLED, true);
        /* Defaults to on (unlike every other toggle here, which defaults off) - see
           shared.js's storedAutoPlayEnabled for why. */
        autoPlayEnabled = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getBoolean(PREF_AUTO_PLAY_ENABLED, true);
        /* Same "defaults on" reasoning as autoPlayEnabled above - see shared.js's
           storedAutoQualityEnabled for why. */
        autoQualityEnabled = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getBoolean(PREF_AUTO_QUALITY_ENABLED, true);
        /* Defaults to off - see shared.js's storedAutoSkipIntroCreditsEnabled for why. */
        autoSkipIntroCreditsEnabled = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getBoolean(PREF_AUTO_SKIP_INTRO_CREDITS, false);
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
        /* Each top-right button after the hamburger claims the next slot outward - same
           per-button stacking chrome.js's registerControlButton computes for its own
           corner control row - rather than hardcoding every button's margin against a
           fixed neighbor, since which buttons exist (Lock) varies per session. Episodes
           lives in the hamburger menu instead (see PlayerUiHelper.renderMainList), not as
           its own top-right icon - unlike Lock/Picture-in-Picture, its queue fetch is a
           real Plex round trip worth a loading state, which fits the menu better than a
           bare icon tap. Each button is 40dp wide; the 56dp step (rather than a flush
           44dp) leaves a deliberate 16dp gap between adjacent icons instead of them
           nearly touching. */
        int nextRightSlotDp = 80;
        if (hasTouchscreen) {
            PlayerUiHelper.buildLockButton(this, density, nextRightSlotDp);
            nextRightSlotDp += 56;
        }
        PlayerUiHelper.buildPipButton(this, density, nextRightSlotDp);
        nextRightSlotDp += 56;
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
               to unconditionally do before double-tap-seek needed tap classification at
               all (see the comment above this detector) - only a tap
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
            (avgSaturation, edgeEnergy, lumaStdDev) -> {
                if (colorBoostSaturationAuto) {
                    autoColorBoostSaturationStrength = AutoStrength.colorBoost(avgSaturation);
                }
                if (colorBoostContrastAuto) {
                    autoColorBoostContrastStrength = AutoStrength.colorBoostContrast(lumaStdDev);
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
        effectsInstalled = false;
        hdrDecided = false;
        // Stale reference to the just-released player's program, if any - nulled rather than
        // left dangling so a toggle firing in the brief window before the new instance's own
        // AiUpscaleEffect.toGlShaderProgram callback lands sees "not installed yet" instead of
        // silently updating a dead GlShaderProgram (see applyVideoEffects's own comment).
        activeAiUpscaleProgram = null;
        DefaultHttpDataSource.Factory httpDataSourceFactory = new DefaultHttpDataSource.Factory();
        /* Wrapped in DefaultDataSource.Factory rather than handing httpDataSourceFactory
           to setDataSourceFactory directly - DefaultMediaSourceFactory uses whatever
           factory it's given for EVERY sub-source it builds, including the sidecar
           subtitle SingleSampleMediaSource, and a bare DefaultHttpDataSource.Factory only
           knows how to open http(s):// connections. The Sync +/- control's local
           file://-URI subtitle (see PlayerActivity's writeSubtitleCacheFile) failed to
           load through it with no crash and no visible error - confirmed against a real
           device: the file existed on disk with valid content, but nothing ever rendered.
           DefaultDataSource.Factory delegates to FileDataSource/AssetDataSource/etc. for
           non-http(s) schemes and falls through to the wrapped httpDataSourceFactory
           unchanged for http(s):// - onSegmentLoadCompleted's own bandwidth-measurement
           reasoning below is untouched by this, since that factory's behavior for
           http(s) requests is exactly the same either way. */
        DefaultMediaSourceFactory mediaSourceFactory = new DefaultMediaSourceFactory(this)
            .setDataSourceFactory(new DefaultDataSource.Factory(this, httpDataSourceFactory));
        /* A fresh processor per player instance, same "fresh state per title" reasoning as
           everStartedPlaying/effectsInstalled above - its own running loudness estimate has
           no reason to carry over into a new title. Always installed regardless of
           audioLevelingEnabled (see AudioLevelingRenderersFactory) - only its own isActive()
           gate, flipped by setAudioLevelingEnabled below, decides whether it does anything. */
        audioLevelingProcessor = new AudioLevelingProcessor();
        audioLevelingProcessor.setEnabled(audioLevelingEnabled);
        player = new ExoPlayer.Builder(this)
            .setRenderersFactory(new AudioLevelingRenderersFactory(this, audioLevelingProcessor))
            .setMediaSourceFactory(mediaSourceFactory)
            .build();
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
                           already uses, so this reads as one continuous player rather
                           than a close-and-relaunch. */
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

    /* Manual entry point from PlayerUiHelper's "Picture-in-Picture" menu row - no
       onUserLeaveHint auto-enter-on-home-press, since that would also fire for exits
       this Activity already handles deliberately (Back/Close -> reportStoppedIfNeeded).
       enterPictureInPictureMode(params) needs API 26; minSdk here is 24 (see
       variables.gradle), so API 24-25 fall back to the deprecated no-arg overload
       instead of just no-op'ing. */
    void enterPip() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            enterPictureInPictureMode(new PictureInPictureParams.Builder()
                .setAspectRatio(pipAspectRatio())
                .build());
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            enterPictureInPictureMode();
        }
    }

    /* PictureInPictureParams.setAspectRatio requires a ratio within [1:2.39, 2.39:1] -
       anything outside that range throws IllegalArgumentException, so an unusually wide/
       tall source gets clamped to the nearest edge of that range rather than passed
       through as-is. Falls back to 16:9 if the video track's real dimensions aren't
       resolved yet (mirrors resolveScaleFactor's own fallback above). */
    private Rational pipAspectRatio() {
        Format format = selectedVideoFormat();
        if (format == null || format.width <= 0 || format.height <= 0) {
            return new Rational(16, 9);
        }
        int width = format.width;
        int height = format.height;
        float ratio = width / (float) height;
        if (ratio > 2.39f) {
            width = Math.round(height * 2.39f);
        } else if (ratio < 1f / 2.39f) {
            height = Math.round(width * 2.39f);
        }
        return new Rational(width, height);
    }

    /* PiP's tiny window has no room for (and, on most launchers, no touch routing to)
       this Activity's own overlay chrome - hide it all for the duration rather than
       leaving faded-but-present buttons a user could still accidentally "tap" through
       the system's PiP touch-to-expand gesture. Restored the same way any other resumed
       interaction reveals it (showControlsTemporarily), not left permanently visible.

       statsOverlayText needs its own explicit hide/restore here - it's deliberately
       independent of setControlsVisible/fadingControls (see buildStatsOverlay's own
       header comment: a debug readout shouldn't fade with the rest of the chrome on
       inactivity), so it would otherwise stay pinned to the shrunken PiP frame. This
       only touches the View's visibility, not the statsOverlayEnabled flag itself, so
       the Performance Overlay toggle's own remembered state survives the PiP round
       trip unchanged. */
    @Override
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);
        isCurrentlyPip = isInPictureInPictureMode;
        if (isInPictureInPictureMode) {
            controlsFadeHandler.removeCallbacks(controlsFadeRunnable);
            setControlsVisible(false);
            PlayerUiHelper.closePlayerMenu(this);
            if (statsOverlayText != null) {
                statsOverlayText.setVisibility(View.GONE);
            }
        } else {
            showControlsTemporarily();
            if (statsOverlayText != null && statsOverlayEnabled) {
                statsOverlayText.setVisibility(View.VISIBLE);
            }
        }
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

    /* Called from every Effects-panel setter, but player.setVideoEffects() itself now only
       actually fires ONCE per player instance (the mandatory pre-prepare() call, or - if that
       one saw real HDR content - the correcting call right after). Every other call just pushes
       fresh tuning into the already-installed AiUpscaleShaderProgram via updateState(), with no
       ExoPlayer API call at all.

       That used to be different: this method used to build a brand-new Effect and call
       player.setVideoEffects() on every single toggle, then force a same-position seekTo to
       unstick the renderer (real-device gotcha: calling setVideoEffects() mid-playback can leave
       ExoPlayer's video renderer wedged). On a live Plex HLS transcode session that seekTo can
       itself stall forever re-requesting the same segment - the actual cause of effects toggles
       "restarting" playback and sometimes never recovering. Rebuilding the pipeline on every
       toggle is what's gone now, not just the seekTo band-aid over it.

       AiUpscaleEffect.isNoOp() always returns false so this node is never elided from the video
       graph, and AiUpscaleShaderProgram.configure() pins its output size to this family's own
       ceiling regardless of live strength/toggle state (see that method's own comment) - both
       needed so a live update never requires Media3 to reconfigure anything downstream. */
    void applyVideoEffects() {
        if (player == null) {
            return;
        }
        boolean hdr = isHdrContent();
        boolean hasTrackInfo = selectedVideoFormat() != null;
        ShaderTuning sharpenTuning = resolveSharpenTuning();
        ColorBoostTuning colorTuning = resolveColorBoostTuning();

        if (!effectsInstalled) {
            // Pre-prepare bootstrap: no track is selected yet, so isHdrContent() above is
            // necessarily false - install optimistically and let the first real
            // onTracksChanged-driven call below correct this if the title turns out to be HDR.
            effectsInstalled = true;
            Log.d(SHADER_TAG, "applyVideoEffects: installing persistent effect (bootstrap)");
            player.setVideoEffects(Collections.singletonList(
                new AiUpscaleEffect(this, detectedShaderType, sharpenTuning, colorTuning, aiUpscalingEnabled)));
        } else if (hasTrackInfo && !hdrDecided) {
            hdrDecided = true;
            if (hdr) {
                Log.d(SHADER_TAG, "applyVideoEffects: HDR content detected, auto-skipping");
                player.setVideoEffects(Collections.emptyList());
                activeAiUpscaleProgram = null;
            }
            // Else: the bootstrap install above is already correct - nothing more to do here.
        }

        if (activeAiUpscaleProgram != null) {
            activeAiUpscaleProgram.updateState(aiUpscalingEnabled, sharpenTuning, colorTuning);
        }
        PlayerUiHelper.updateStatsOverlay(this);
    }

    /* Both Sharpening and Color Boost share one GL pass (see AiUpscaleShaderProgram's own header
       comment) - detectedShaderType always picks a real algorithm to render through (whichever
       this title's genre auto-detected) even when Sharpening itself is off, with the returned
       tuning forced to ShaderType.NEUTRAL in that case rather than detectedShaderType.tuningAt(0)
       (which would apply that type's lightest-tier sharpen amount, not true zero - see
       ShaderType.NEUTRAL's own comment).

       sharpenOn alone isn't enough to gate this - resolveShaderType keeps shaderType resolved to
       a real type throughout Auto mode regardless of the live auto strength (it has to, so
       ContentAnalysisSampler keeps running for whenever a nonzero value does arrive). But
       tuningAt(0) returns that type's own MIN tuning, not true zero - the same "0 strength" that
       means fully off in manual mode (there, shaderType itself already becomes OFF at exactly 0,
       hitting the sharpenOn=false branch below) would otherwise render as still-visibly-sharpened
       once auto legitimately computes 0 (source doesn't need upscaling). Checking
       resolvedUpscaleStrength > 0f here too is what actually makes a live 0 look like NEUTRAL,
       regardless of which mode produced it. */
    private ShaderTuning resolveSharpenTuning() {
        boolean sharpenOn = shaderType != ShaderType.OFF;
        float resolvedUpscaleStrength = upscaleAuto ? autoUpscaleStrength : upscaleStrength;
        return (sharpenOn && resolvedUpscaleStrength > 0f)
            ? detectedShaderType.tuningAt(resolvedUpscaleStrength)
            : ShaderType.NEUTRAL;
    }

    /* Auto strength (see ContentAnalysisSampler/AutoStrength) resolves separately from
       colorBoostSaturationStrength/colorBoostContrastStrength rather than overwriting them -
       those stay the remembered manual slider position, restored the moment auto is unchecked.
       Saturation and Contrast are fully independent - each its own enabled/auto pair, each
       auto-deriving from its own signal (avgSaturation vs lumaStdDev, see
       AutoStrength.colorBoost/colorBoostContrast) - so a component whose toggle is off resolves
       to strength 0 here, which ColorBoostTuning.at's own min-lerp already turns into an exact
       1.0 (no-op) for that component. */
    private ColorBoostTuning resolveColorBoostTuning() {
        boolean colorBoostOn = colorBoostSaturationEnabled || colorBoostContrastEnabled;
        float resolvedColorBoostSaturationStrength = !colorBoostSaturationEnabled ? 0f
            : (colorBoostSaturationAuto ? autoColorBoostSaturationStrength : colorBoostSaturationStrength);
        float resolvedColorBoostContrastStrength = !colorBoostContrastEnabled ? 0f
            : (colorBoostContrastAuto ? autoColorBoostContrastStrength : colorBoostContrastStrength);
        return colorBoostOn
            ? ColorBoostTuning.at(resolvedColorBoostSaturationStrength, resolvedColorBoostContrastStrength)
            : ColorBoostTuning.NEUTRAL;
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

    /* Audio counterpart to selectedVideoFormat() above, same package-private access for
       PlayerUiHelper's stats overlay Audio line - not read anywhere else yet. */
    Format selectedAudioFormat() {
        if (player == null) return null;
        for (Tracks.Group group : player.getCurrentTracks().getGroups()) {
            if (group.getType() != C.TRACK_TYPE_AUDIO) continue;
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
       notes) - our shadow-crush fix (see the shared sharpen shaders' shadowProtect) was tuned
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

    /* Whether AI Upscaling's own preset would actually run right now, purely from current
       geometry - the same gate AiUpscaleShaderProgram.configure() folds into its own
       upgradeGateOk every time the input format changes (see that method's own comment),
       computed here too so PlayerUiHelper's Effects panel can grey out a toggle that would
       otherwise be a no-op (source already fills playerView, nothing to upscale). Optimistic
       (true) whenever it can't yet be answered - no track selected yet, or no preset registered
       for this family/device (Sharpening alone still applies then, so there's nothing to
       disable) - so a still-loading title never flashes "disabled" incorrectly. */
    boolean wouldAiUpscaleSource() {
        Format format = selectedVideoFormat();
        if (format == null || format.width <= 0 || format.height <= 0 || playerView.getWidth() <= 0 || playerView.getHeight() <= 0) {
            return true;
        }
        AiUpscalingPresets.Preset preset = AiUpscalingPresets.forFamily(getAssets(), detectedShaderType);
        if (preset == null || preset.when == null) return true;
        float scale = Math.max(1f, Math.min(preset.scale,
            Math.min(playerView.getWidth() / (float) format.width, playerView.getHeight() / (float) format.height)));
        int outW = Math.round(format.width * scale);
        int outH = Math.round(format.height * scale);
        return preset.when.test(format.width, format.height, outW, outH);
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
       renderAmbientSection in PlayerUiHelper for why that one doesn't need to gate to the
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

    /* Same immediate-persistence model as setShaderEnabled above. Still gated to
       onStopTrackingTouch by PlayerUiHelper's Shader Upscaling SeekBar rather than drag
       frequency - applyVideoEffects() itself is cheap now (see its own header comment), so
       this is no longer load-bearing for correctness, just avoids a SharedPreferences write
       and a stats-overlay refresh per drag frame. */
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

    /* Same immediate-persistence model as setShaderEnabled/setUpscaleAuto above - independent
       of Sharpening's own state entirely, see AiUpscaleEffect's own header comment. */
    void setAiUpscalingEnabled(boolean enabled) {
        aiUpscalingEnabled = enabled;
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putBoolean(PREF_AI_UPSCALING_ENABLED, enabled).apply();
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
       setAmbientEnabled above. Saturation and Contrast are fully independent controls -
       each its own enabled/auto pair - rather than one shared Color Boost toggle.
       PlayerUiHelper's Color Boost strength SeekBars still gate the actual apply to
       onStopTrackingTouch rather than drag frequency, though that's no longer load-bearing
       for correctness - see setShaderStrength's own comment. */
    void setColorBoostSaturationEnabled(boolean enabled) {
        colorBoostSaturationEnabled = enabled;
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putBoolean(PREF_COLOR_BOOST_SATURATION_ENABLED, enabled).apply();
        applyVideoEffects();
    }

    void setColorBoostContrastEnabled(boolean enabled) {
        colorBoostContrastEnabled = enabled;
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putBoolean(PREF_COLOR_BOOST_CONTRAST_ENABLED, enabled).apply();
        applyVideoEffects();
    }

    void setColorBoostSaturationStrength(float strength) {
        colorBoostSaturationStrength = strength;
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putFloat(PREF_COLOR_BOOST_SATURATION_STRENGTH, strength).apply();
        applyVideoEffects();
    }

    void setColorBoostContrastStrength(float strength) {
        colorBoostContrastStrength = strength;
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putFloat(PREF_COLOR_BOOST_CONTRAST_STRENGTH, strength).apply();
        applyVideoEffects();
    }

    /* Same immediate-persistence model as setColorBoostSaturationEnabled/setUpscaleAuto
       above. Independent of setColorBoostContrastAuto below - each auto-derives from its
       own signal (avgSaturation vs lumaStdDev, see AutoStrength), so there's no shared
       auto state left to couple them through. */
    void setColorBoostSaturationAuto(boolean enabled) {
        colorBoostSaturationAuto = enabled;
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putBoolean(PREF_COLOR_BOOST_SATURATION_AUTO, enabled).apply();
        updateContentAnalysis();
        applyVideoEffects();
    }

    /* Same reasoning as setColorBoostSaturationAuto above, mirrored for Contrast. */
    void setColorBoostContrastAuto(boolean enabled) {
        colorBoostContrastAuto = enabled;
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putBoolean(PREF_COLOR_BOOST_CONTRAST_AUTO, enabled).apply();
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

    /* Same collapsing reasoning as upscaleMode/setUpscaleMode above, one independent
       triple per component now instead of one shared Color Boost mode. */
    String colorBoostSaturationMode() {
        if (!colorBoostSaturationEnabled) return "off";
        return colorBoostSaturationAuto ? "auto" : "on";
    }

    void setColorBoostSaturationMode(String mode) {
        setColorBoostSaturationEnabled(!"off".equals(mode));
        setColorBoostSaturationAuto("auto".equals(mode));
    }

    String colorBoostContrastMode() {
        if (!colorBoostContrastEnabled) return "off";
        return colorBoostContrastAuto ? "auto" : "on";
    }

    void setColorBoostContrastMode(String mode) {
        setColorBoostContrastEnabled(!"off".equals(mode));
        setColorBoostContrastAuto("auto".equals(mode));
    }

    /* Starts/stops the shared content-analysis capture loop based on whether any auto
       mode needs it - mirrors content-analysis.js's updateContentAnalysis on the web leg.
       Called from setUpscaleAuto/setColorBoostSaturationAuto/setColorBoostContrastAuto
       above. */
    void updateContentAnalysis() {
        if (contentSampler == null) return;
        if (upscaleAuto || colorBoostSaturationAuto || colorBoostContrastAuto) {
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
       setStatsOverlayEnabled above, but the thing being re-applied is a native
       AudioProcessor's own isActive() gate (see AudioLevelingProcessor) rather than a
       View/GL pipeline this Activity owns directly - already-installed, so toggling never
       needs to touch the player/RenderersFactory at all, just this one flag. */
    void setAudioLevelingEnabled(boolean enabled) {
        audioLevelingEnabled = enabled;
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putBoolean(PREF_AUDIO_LEVELING_ENABLED, enabled).apply();
        if (audioLevelingProcessor != null) {
            audioLevelingProcessor.setEnabled(enabled);
        }
    }

    /* Same "toggle IS the persisted setting" immediate-persistence model as
       setStatsOverlayEnabled above - no view to update, just the flag itself, read back
       by the STATE_ENDED handler whenever a title actually finishes. */
    void setAutoPlayEnabled(boolean enabled) {
        autoPlayEnabled = enabled;
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putBoolean(PREF_AUTO_PLAY_ENABLED, enabled).apply();
        notifyAutoSkipSettingsChanged();
    }

    /* Same immediate-persistence model as setAutoPlayEnabled above - see
       PlayerUiHelper's "Auto-Skip Intro & Credits" row, greyed out (but not force-
       cleared, same "stays whatever it was" reasoning as the JS chrome's own row) while
       autoPlayEnabled is off. */
    void setAutoSkipIntroCreditsEnabled(boolean enabled) {
        autoSkipIntroCreditsEnabled = enabled;
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putBoolean(PREF_AUTO_SKIP_INTRO_CREDITS, enabled).apply();
        notifyAutoSkipSettingsChanged();
    }

    /* Both toggles above feed one JS-side decision (native-bridge.js's progress
       listener - see that file's own comment for why markers/auto-skip stay JS-decided
       even on this native-chrome platform), so either one changing needs to reach JS
       live, not just at the next getAutoSkipSettings query. */
    private void notifyAutoSkipSettingsChanged() {
        if (listener != null) listener.onAutoSkipSettingsChanged(autoPlayEnabled, autoSkipIntroCreditsEnabled);
    }

    /* Read once by native-bridge.js's getAutoSkipSettings call at the start of a native
       session (before an Activity - and so before autoPlayEnabled/autoSkipIntroCreditsEnabled
       instance fields - even exists), so it goes straight to SharedPreferences rather
       than through activeInstance. */
    static boolean getAutoPlayEnabledPref(Context context) {
        return context.getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getBoolean(PREF_AUTO_PLAY_ENABLED, true);
    }

    static boolean getAutoSkipIntroCreditsEnabledPref(Context context) {
        return context.getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getBoolean(PREF_AUTO_SKIP_INTRO_CREDITS, false);
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
        if (!"fit".equals(aspectMode)) {
            /* Cover/Stretch (see applyAspectMode) fill the screen exactly by definition - no
               letterbox gap exists for the glow to show in, regardless of videoAR/screenAR. */
            w = vw;
            h = vh;
        } else if (videoAR > screenAR) {
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
        reportNativeTimeline("playing");
    }

    private void stopProgressLoop() {
        progressHandler.removeCallbacks(progressRunnable);
    }

    /* plex-player.js's own :/timeline reporting (_reportTimeline, driven by a JS
       setInterval) NEVER reaches Plex during native playback - confirmed on a real
       device: PlayerActivity is a genuinely separate Activity (started via
       startActivityForResult), so launching it backgrounds the Capacitor BridgeActivity
       hosting the WebView, and Android's WebView.onPause() (which Capacitor's own
       Activity lifecycle calls automatically) doesn't just freeze JS timers, it
       suspends the WebView's own network resource loading entirely - confirmed directly
       by evaluating a plain fetch() inside that backgrounded WebView via its remote
       debugging socket and observing it never resolve at all, for as long as
       PlayerActivity stayed in the foreground. An earlier fix attempted to work around
       just the frozen-timer half of this (piggybacking a throttled ping on native-bridge.js's
       already-reliable "progress" event, which native code delivers into the WebView
       directly and which keeps firing regardless of WebView.onPause()) - that still
       didn't help, because the ping's own fetch() call was itself the thing silently
       hanging, not the timer that would have scheduled it. Since PlexHttp uses a plain
       HttpURLConnection from native code, entirely independent of the WebView, this is
       the only leg of the app that can actually get a :/timeline ping out while this
       Activity owns the foreground - a deliberate, one-off duplication of plex-player.js's
       own :/timeline protocol implementation (ratingKey/key/state/time/duration/
       X-Plex-Client-Identifier/X-Plex-Token), not a stylistic preference, forced by that
       WebView limitation. Every field it needs is already recoverable from currentUrl's
       own query params (path IS "/library/metadata/<ratingKey>", already used verbatim
       as the transcode URL's own path param) rather than needing a new bridge extra. */
    private void reportNativeTimeline(String state) {
        if (currentUrl == null) return;
        Uri uri = Uri.parse(currentUrl);
        String token = uri.getQueryParameter("X-Plex-Token");
        String path = uri.getQueryParameter("path");
        String clientId = uri.getQueryParameter("X-Plex-Client-Identifier");
        if (token == null || path == null) return;
        int lastSlash = path.lastIndexOf('/');
        String ratingKey = lastSlash >= 0 ? path.substring(lastSlash + 1) : path;
        String plexUrl = uri.getScheme() + "://" + uri.getAuthority();
        long positionMs = player != null ? player.getCurrentPosition() : 0L;
        long durationMs = player != null ? player.getDuration() : 0L;
        if (durationMs == androidx.media3.common.C.TIME_UNSET) durationMs = 0L;
        Uri timelineUri = Uri.parse(plexUrl + "/:/timeline").buildUpon()
            .appendQueryParameter("ratingKey", ratingKey)
            .appendQueryParameter("key", path)
            .appendQueryParameter("state", state)
            .appendQueryParameter("time", String.valueOf(positionMs))
            .appendQueryParameter("duration", String.valueOf(durationMs))
            .appendQueryParameter("X-Plex-Client-Identifier", clientId != null ? clientId : "")
            .appendQueryParameter("X-Plex-Token", token)
            .build();
        PlexHttp.runAsync(() -> {
            PlexHttp.getSync(timelineUri.toString());
            return null;
        }, ignored -> {});
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
        long now = System.currentTimeMillis();
        if (now - lastNativeTimelinePingAt >= NATIVE_TIMELINE_PING_MS) {
            lastNativeTimelinePingAt = now;
            boolean isPlaying = player != null && player.getPlayWhenReady();
            reportNativeTimeline(isPlaying ? "playing" : "paused");
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

    /* Every one of these four - like setSubtitleText further down - touches the
       ExoPlayer instance directly from a Capacitor plugin method. Capacitor plugin
       calls arrive on their own "CapacitorPlugins" thread, never main, and ExoPlayer
       enforces "accessed on main thread only" on essentially every public method, not
       just the view-mutation style calls below - confirmed via a real device crash log
       for setSubtitleText's own getCurrentPosition() call. These four were the same
       latent crash, just not yet hit by anything that exercised them. */
    public static void pause() {
        if (activeInstance != null && activeInstance.player != null) {
            activeInstance.runOnUiThread(() -> {
                if (activeInstance.player != null) activeInstance.player.setPlayWhenReady(false);
            });
        }
    }

    public static void resume() {
        if (activeInstance != null && activeInstance.player != null) {
            activeInstance.runOnUiThread(() -> {
                if (activeInstance.player != null) activeInstance.player.setPlayWhenReady(true);
            });
        }
    }

    public static void seek(long positionMs) {
        if (activeInstance != null && activeInstance.player != null) {
            activeInstance.runOnUiThread(() -> {
                if (activeInstance.player != null) activeInstance.player.seekTo(positionMs);
            });
        }
    }

    public static void setPlaybackSpeed(float speed) {
        if (activeInstance != null && activeInstance.player != null) {
            activeInstance.runOnUiThread(() -> {
                if (activeInstance.player != null) activeInstance.player.setPlaybackParameters(new PlaybackParameters(speed));
            });
        }
    }

    public static void setAspectMode(String mode) {
        if (activeInstance != null) {
            activeInstance.runOnUiThread(() -> activeInstance.applyAspectMode(mode));
        }
    }

    /* "fit" letterboxes (ExoPlayer's own default), "cover" crops to fill without distorting,
       "stretch" fills exactly, distorting the picture - same three options as the web/Xbox
       leg's Aspect picker (chrome-menu-options.js's applyFitMode), applied here via
       PlayerView's own AspectRatioFrameLayout instead of a CSS object-fit. layoutGlow (see its
       own comment) has to know the current mode too: Cover/Stretch leave no letterbox gap for
       ambient lighting's edge glow to show in, regardless of the video's own aspect ratio. */
    private void applyAspectMode(String mode) {
        aspectMode = mode;
        int resizeMode;
        if ("cover".equals(mode)) resizeMode = AspectRatioFrameLayout.RESIZE_MODE_ZOOM;
        else if ("stretch".equals(mode)) resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FILL;
        else resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT;
        playerView.setResizeMode(resizeMode);
    }

    /* View mutations, same as the player-only static methods above, need to run on the
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
    /* Called from PlayerUiHelper's Audio & Subtitles search button, already on the UI
       thread - same "no thread hop needed" reasoning as requestEpisodeList above. query
       is whatever the user typed (falls back to this title in PlayerUiHelper if left
       untouched) - JS resolves the actual Plex subtitle search and calls
       showSubtitleResults below with the result. */
    static void requestSubtitleSearch(String query) {
        if (listener != null) {
            listener.onSubtitleSearchRequested(query);
        }
    }

    /* Called from a subtitle result row tap - fileId is opaque to Java (see
       SubtitleResultEntry), label/languageCode travel along so JS doesn't need a lookup
       and so notifySubtitleApplied below can just echo them straight back. */
    static void requestSubtitleSelect(String fileId, String label, String languageCode) {
        if (listener != null) {
            listener.onSubtitleSelectRequested(fileId, label, languageCode);
        }
    }

    /* Bridge entry point for NativePlayerPlugin.showSubtitleResults - the asynchronous
       response to requestSubtitleSearch above. Same runOnUiThread reasoning as
       showEpisodeList: a Capacitor plugin call isn't guaranteed to arrive on the UI
       thread and this rebuilds the open overlay's Subtitles column. */
    public static void showSubtitleResults(String resultsJson, String error) {
        if (activeInstance != null) {
            activeInstance.runOnUiThread(() -> activeInstance.showSubtitleResultsInternal(resultsJson, error));
        }
    }

    private void showSubtitleResultsInternal(String resultsJson, String error) {
        subtitleResults.clear();
        subtitleResults.addAll(parseSubtitleResults(resultsJson));
        subtitleSearchStatus = error != null ? "error" : "done";
        subtitleSearchError = error;
        PlayerUiHelper.refreshAudioSubtitlesMenu(this);
    }

    /* Same org.json.JSONArray/optString parsing idiom as parseEpisodeList/
       parseAudioStreams - plex-subtitles.js's search() result is already resolved/
       formatted in JS, this just rebuilds it into Java objects. */
    private static List<SubtitleResultEntry> parseSubtitleResults(String json) {
        List<SubtitleResultEntry> results = new ArrayList<>();
        if (json == null) return results;
        try {
            org.json.JSONArray arr = new org.json.JSONArray(json);
            for (int i = 0; i < arr.length(); i++) {
                org.json.JSONObject obj = arr.getJSONObject(i);
                results.add(new SubtitleResultEntry(
                    obj.optString("fileId", ""),
                    obj.optString("label", ""),
                    obj.optString("languageCode", "en")));
            }
        } catch (org.json.JSONException e) {
            // malformed subtitle-search data - show nothing rather than crash
        }
        return results;
    }

    /* Bridge entry point for NativePlayerPlugin.notifySubtitleApplied - the success leg
       of the requestSubtitleSelect round trip above, arriving after JS has already
       called setSubtitleText (the actual attach) separately. Kept as two distinct
       native calls rather than one, so setSubtitleText's signature (shared with the
       dead-but-kept-correct web/chrome.js Android branch) doesn't need to grow
       fileId/label params it has no other use for. */
    public static void notifySubtitleApplied(String fileId, String label) {
        if (activeInstance != null) {
            activeInstance.runOnUiThread(() -> activeInstance.notifySubtitleAppliedInternal(fileId, label));
        }
    }

    private void notifySubtitleAppliedInternal(String fileId, String label) {
        currentSubtitleFileId = fileId;
        currentSubtitleLabel = label;
        subtitlePendingFileId = null;
        subtitleApplyErrorFileId = null;
        PlayerUiHelper.refreshAudioSubtitlesMenu(this);
    }

    /* Bridge entry point for NativePlayerPlugin.notifySubtitleApplyFailed - the failure
       leg (resolveDownloadLink or setSubtitle rejected) of the same round trip. */
    public static void notifySubtitleApplyFailed(String fileId, String message) {
        if (activeInstance != null) {
            activeInstance.runOnUiThread(() -> activeInstance.notifySubtitleApplyFailedInternal(fileId, message));
        }
    }

    private void notifySubtitleApplyFailedInternal(String fileId, String message) {
        subtitlePendingFileId = null;
        subtitleApplyErrorFileId = fileId;
        subtitleApplyErrorMessage = message;
        PlayerUiHelper.refreshAudioSubtitlesMenu(this);
    }

    /* The "Off" row - fully native for the apply itself (unlike selecting a real
       result, clearing one has no external download to resolve). Mirrors applySubtitle
       below (rebuild the MediaItem in place, same resumeMs/prepare/notifyReload
       sequence) but with no SubtitleConfigurations at all, rather than a real one.
       Still notifies JS afterward (onSubtitleCleared) - JS remembers the last-applied
       subtitle per title (src/player/core/subtitle-store.js) to auto-reapply it next
       time this title plays, and without this notification that memory would never
       learn the user turned it back off here, silently reapplying every time. */
    void clearSubtitleTrack() {
        if (player == null || currentUrl == null) return;
        long resumeMs = player.getCurrentPosition();
        MediaItem newItem = new MediaItem.Builder()
            .setUri(Uri.parse(currentUrl))
            .build();
        player.setMediaItem(newItem, resumeMs);
        player.prepare();
        if (abrMonitor != null) abrMonitor.notifyReload();
        currentSubtitleSrtText = null;
        currentSubtitleOffsetMs = 0;
        currentSubtitleUri = null;
        currentSubtitleLanguageCode = null;
        currentSubtitleMimeType = null;
        currentSubtitleFileId = null;
        currentSubtitleLabel = null;
        subtitlePendingFileId = null;
        subtitleApplyErrorFileId = null;
        PlayerUiHelper.refreshAudioSubtitlesMenu(this);
        if (listener != null) listener.onSubtitleCleared();
    }

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
            String partId, String mediaVersionsJson, Integer currentMediaIndex, Integer qualityCapKbps) {
        if (activeInstance != null) {
            activeInstance.runOnUiThread(() -> activeInstance.applyTitleSwitch(url, startPositionMs, shaderType,
                title, episodeTitle, year, seasonNumber, episodeNumber, queueLength, queueIndex,
                chaptersJson, bifUrl, audioStreamsJson, partId, mediaVersionsJson, currentMediaIndex, qualityCapKbps));
        }
    }

    /* Swaps the currently playing title in place - same Activity instance, same
       ExoPlayer, same ambient/shader GL pipeline - instead of finish()-ing and letting
       NativePlayerPlugin.play() relaunch a fresh PlayerActivity for the next title. That
       relaunch is what used to make title-prev/title-next (the on-screen buttons, see
       PlayerUiHelper.seekToAdjacentTitle) visibly swipe the whole window out and back in
       for what should read as one continuous player. Mirrors the per-title subset of
       onCreate's own setup - everything NOT tied to the Activity/PlayerView/ExoPlayer
       instance itself (which onCreate builds once and this reuses unchanged). */
    void applyTitleSwitch(String url, long startPositionMs, String shaderTypeName, String newTitle,
            String newEpisodeTitle, Integer newYear, Integer newSeasonNumber, Integer newEpisodeNumber,
            Integer newQueueLength, Integer newQueueIndex, String chaptersJson, String bifUrl, String audioStreamsJson,
            String newPartId, String mediaVersionsJson, Integer newCurrentMediaIndex, Integer newQualityCapKbps) {
        if (player == null) return;

        PlayerUiHelper.closePlayerMenu(this);
        PlayerUiHelper.closeEpisodeListMenu(this);
        PlayerUiHelper.closeChapterListMenu(this);
        PlayerUiHelper.closeAudioSubtitlesMenu(this);
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
        partId = newPartId;
        parseMediaVersions(mediaVersionsJson);
        /* A title switch already drops any active sidecar subtitle track (see
           applySubtitle's own header comment) - reset the bookkeeping alongside it
           rather than leaving a stale "currently selected" checkmark pointing at a file
           that no longer applies to whatever's now playing. */
        subtitleResults.clear();
        currentSubtitleSrtText = null;
        currentSubtitleOffsetMs = 0;
        currentSubtitleUri = null;
        currentSubtitleLanguageCode = null;
        currentSubtitleMimeType = null;
        currentSubtitleFileId = null;
        currentSubtitleLabel = null;
        subtitlePendingFileId = null;
        subtitleApplyErrorFileId = null;
        subtitleSearchQueryText = null;
        subtitleSearchStatus = "idle";
        subtitleSearchError = null;
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
       HLS transcode source, see this phase's open risks. Takes the raw .srt TEXT now,
       not a bare URL - the Sync +/- control (adjustSubtitleOffset below) needs the
       original, un-shifted timestamps cached on this side so every click can re-shift
       and rewrite a local file without re-hitting Plex, and ExoPlayer only ever
       reads whatever's currently on disk (currentSubtitleUri), never this text directly. */
    public static void setSubtitleText(String srtText, String languageCode, String mimeType) {
        if (activeInstance != null) {
            /* Capacitor plugin methods run on their own "CapacitorPlugins" thread, not
               main - every ExoPlayer call (getCurrentPosition/setMediaItem/prepare below)
               enforces "accessed on main thread only" and crashes otherwise (confirmed
               via a real device crash log: IllegalStateException at
               ExoPlayerImpl.verifyApplicationThread). Every other bridge entry point in
               this file already hops via runOnUiThread for the same reason - this one
               was just missing it. */
            activeInstance.runOnUiThread(() -> activeInstance.applySubtitle(srtText, languageCode, mimeType));
        }
    }

    private void applySubtitle(String srtText, String languageCode, String mimeType) {
        if (player == null || currentUrl == null) return;
        currentSubtitleSrtText = srtText;
        currentSubtitleOffsetMs = 0;
        currentSubtitleLanguageCode = languageCode;
        currentSubtitleMimeType = mimeType;
        if (!writeSubtitleCacheFile()) return;
        /* SELECTION_FLAG_DEFAULT alone isn't enough - confirmed against a real device:
           the subtitle attaches and re-prepares with no error, but DefaultTrackSelector
           still never turns it on, because its default behavior is to only auto-select a
           text track whose language matches TrackSelectionParameters.preferredTextLanguages
           (empty here) or is itself undetermined - a sideloaded sidecar track carrying a
           real language tag matches neither by default. Setting both here, rather than
           relying on either alone, covers a track missing a language tag too. */
        player.setTrackSelectionParameters(
            player.getTrackSelectionParameters().buildUpon()
                .setPreferredTextLanguage(languageCode)
                .setSelectUndeterminedTextLanguage(true)
                .build());
        reloadWithCurrentSubtitle();
    }

    /* Absolute setter shared by adjustSubtitleOffset (delta, from PlayerUiHelper's Sync
       +/- buttons) and the static setSubtitleOffsetMs below (absolute, from JS
       restoring a remembered offset via NativePlayerPlugin.setSubtitleOffset) - both
       funnel through here so there's one write+reload path, not two. Returns whether
       it actually took effect, so adjustSubtitleOffset can skip notifying JS of a
       no-op (player/currentSubtitleSrtText not ready, or the cache file write failed). */
    private boolean applySubtitleOffset(long offsetMs) {
        if (player == null || currentSubtitleSrtText == null) return false;
        currentSubtitleOffsetMs = offsetMs;
        if (!writeSubtitleCacheFile()) return false;
        reloadWithCurrentSubtitle();
        PlayerUiHelper.refreshAudioSubtitlesMenu(this);
        return true;
    }

    /* Called directly from PlayerUiHelper's Sync +/- buttons, fully native for the
       apply itself (no JS round trip needed there) - unlike the initial apply above,
       currentSubtitleSrtText is already cached from that first fetch, so nudging the
       offset never re-hits Plex. Mirrors chrome.js's own adjustSubtitleOffset
       (250ms/click) on the web leg, which mutates already-parsed VTTCue objects
       directly instead of a source file - this rewrites the on-disk .srt instead,
       since ExoPlayer's SubripDecoder parses that itself and there's no equivalent
       live cue list on this side to mutate in place. Still notifies JS afterward
       (onSubtitleOffsetChanged), same reasoning as clearSubtitleTrack's
       onSubtitleCleared - JS persists the offset per title (subtitle-store.js's
       setAppliedOffsetMs) so it can restore it on the next play, and without this
       notification it would never learn a native Sync click happened at all. */
    void adjustSubtitleOffset(long deltaMs) {
        if (!applySubtitleOffset(currentSubtitleOffsetMs + deltaMs)) return;
        if (listener != null) listener.onSubtitleOffsetChanged(currentSubtitleOffsetMs);
    }

    /* Called from NativePlayerPlugin.setSubtitleOffset - JS restoring a remembered Sync
       offset right after a fresh subtitle apply, same apply-then-restore sequence
       chrome.js's own applyRememberedSubtitle uses on the web/Xbox leg. No listener
       notification back out of here (unlike adjustSubtitleOffset above) - JS already
       knows this value, it's the one that just sent it. */
    static void setSubtitleOffsetMs(long offsetMs) {
        if (activeInstance != null) {
            activeInstance.runOnUiThread(() -> activeInstance.applySubtitleOffset(offsetMs));
        }
    }

    /* currentSubtitleOffsetMs itself is private (only the reload plumbing above should
       mutate it) - this is PlayerUiHelper's read-only window onto it for the Sync row's
       own label. */
    long subtitleOffsetMs() {
        return currentSubtitleOffsetMs;
    }

    /* Shared by applySubtitle/adjustSubtitleOffset above and every reload path that
       rebuilds the MediaItem for its own unrelated reason (switchAudioStream/
       switchMediaVersion/switchQualityCap below) - resumeMs/prepare/notifyReload is the
       same sequence every one of them needs, and currentSubtitleConfigOrNull is what
       lets the latter three carry forward whatever's already in currentSubtitleUri
       without themselves knowing anything about subtitles. */
    private void reloadWithCurrentSubtitle() {
        long resumeMs = player.getCurrentPosition();
        MediaItem.Builder itemBuilder = new MediaItem.Builder().setUri(Uri.parse(currentUrl));
        MediaItem.SubtitleConfiguration subtitleConfig = currentSubtitleConfigOrNull();
        if (subtitleConfig != null) itemBuilder.setSubtitleConfigurations(java.util.Collections.singletonList(subtitleConfig));
        player.setMediaItem(itemBuilder.build(), resumeMs);
        player.prepare();
        if (abrMonitor != null) abrMonitor.notifyReload();
    }

    /* Writes currentSubtitleSrtText, shifted by currentSubtitleOffsetMs, to a fixed
       cache-dir file and points currentSubtitleUri at it - a fixed filename is fine
       since every caller immediately follows this with a fresh setMediaItem+prepare()
       that re-reads it, and Media3's file:// DataSource has no caching layer of its own
       to bust between one offset click and the next. Returns false (leaving the
       previous currentSubtitleUri/file untouched) on write failure rather than handing
       ExoPlayer a half-written or stale file. */
    private boolean writeSubtitleCacheFile() {
        String shifted = currentSubtitleOffsetMs == 0
            ? currentSubtitleSrtText
            : shiftSrtTimestamps(currentSubtitleSrtText, currentSubtitleOffsetMs);
        java.io.File file = new java.io.File(getCacheDir(), "prism_subtitle.srt");
        try (java.io.FileWriter writer = new java.io.FileWriter(file, false)) {
            writer.write(shifted);
        } catch (java.io.IOException e) {
            return false;
        }
        currentSubtitleUri = Uri.fromFile(file);
        return true;
    }

    private static final java.util.regex.Pattern SRT_TIMESTAMP_PATTERN =
        java.util.regex.Pattern.compile("(\\d{2}):(\\d{2}):(\\d{2}),(\\d{3})");

    /* SRT timestamps are "HH:MM:SS,mmm" - shifts every one found by offsetMs, clamped
       at 0 so a large negative offset can't produce a negative/malformed timestamp. */
    private static String shiftSrtTimestamps(String srt, long offsetMs) {
        java.util.regex.Matcher m = SRT_TIMESTAMP_PATTERN.matcher(srt);
        StringBuffer out = new StringBuffer();
        while (m.find()) {
            long totalMs = Long.parseLong(m.group(1)) * 3600000L
                + Long.parseLong(m.group(2)) * 60000L
                + Long.parseLong(m.group(3)) * 1000L
                + Long.parseLong(m.group(4));
            long shiftedMs = Math.max(0, totalMs + offsetMs);
            long h = shiftedMs / 3600000; shiftedMs %= 3600000;
            long mi = shiftedMs / 60000; shiftedMs %= 60000;
            long s = shiftedMs / 1000; long millis = shiftedMs % 1000;
            m.appendReplacement(out, String.format(java.util.Locale.US, "%02d:%02d:%02d,%03d", h, mi, s, millis));
        }
        m.appendTail(out);
        return out.toString();
    }

    /* Null whenever no subtitle is currently active - callers must check before calling
       MediaItem.Builder.setSubtitleConfigurations, which doesn't accept a null element. */
    private MediaItem.SubtitleConfiguration currentSubtitleConfigOrNull() {
        if (currentSubtitleUri == null) return null;
        return new MediaItem.SubtitleConfiguration.Builder(currentSubtitleUri)
            .setMimeType(currentSubtitleMimeType)
            .setLanguage(currentSubtitleLanguageCode)
            .setSelectionFlags(C.SELECTION_FLAG_DEFAULT)
            .build();
    }

    /* Plezy-style fix (see stream-url.js's directStreamAudio comment, mirrored on
       PlexHttp's own transcode param builder): tries a local, in-place track selection
       first via TrackSelectionParameters, which touches nothing over the network and
       needs no setMediaItem/prepare at all, before ever falling back to
       switchAudioStreamViaRestart's session-restart mechanism below. */
    void switchAudioStream(String streamId) {
        if (player == null || currentUrl == null) return;
        if (switchAudioStreamLocally(streamId)) return;
        switchAudioStreamViaRestart(streamId);
    }

    /* directStreamAudio=1 on the transcode start URL (see stream-url.js's own comment
       for the full reasoning) makes Plex remux every embedded audio track into the
       running HLS session as its own EXT-X-MEDIA rendition, instead of collapsing to
       whichever one was selected at session start - so ExoPlayer's HlsMediaSource
       already exposes one audio TrackGroup per Plex audio stream, and switching is a
       live TrackSelectionParameters override, not a new session.

       Guarded by a group-count match against `audioStreams`, not just attempted blind:
       unverified whether Plex's EXT-X-MEDIA group order always matches the Part's own
       Stream order on every server/source combination (this file's audioStreams list
       IS that Stream order - see native-bridge.js's buildPlaybackPayload), and a source
       where directStreamAudio didn't produce a matching rendition per track (still
       under 2 groups, in particular) needs to fall back to the old restart mechanism
       rather than silently selecting the wrong track or no-op'ing. Returns whether the
       local switch actually applied. */
    private boolean switchAudioStreamLocally(String streamId) {
        List<TrackGroup> audioGroups = new ArrayList<>();
        for (Tracks.Group group : player.getCurrentTracks().getGroups()) {
            if (group.getType() == C.TRACK_TYPE_AUDIO) audioGroups.add(group.getMediaTrackGroup());
        }
        if (audioGroups.size() < 2 || audioGroups.size() != audioStreams.size()) return false;
        int index = -1;
        for (int i = 0; i < audioStreams.size(); i++) {
            if (audioStreams.get(i).id.equals(streamId)) {
                index = i;
                break;
            }
        }
        if (index < 0) return false;
        /* Bumped even on this synchronous path - see reloadGeneration's own field
           comment. Invalidates any restart-based reload that's still in flight from an
           earlier switch, so its eventual apply() can't stomp on this one once it lands. */
        ++reloadGeneration;
        player.setTrackSelectionParameters(
            player.getTrackSelectionParameters().buildUpon()
                .clearOverridesOfType(C.TRACK_TYPE_AUDIO)
                .addOverride(new TrackSelectionOverride(audioGroups.get(index), 0))
                .build());
        currentAudioStreamId = streamId;
        selectAudioStreamOnPlexAsync(streamId);
        return true;
    }

    /* Fire-and-forget PUT to keep Plex's own Part-level "selected" bookkeeping in sync
       for other clients/the next launch - same request switchAudioStreamViaRestart's
       canSelectStream branch below sends, just with no matching session restart to wait
       on since switchAudioStreamLocally's caller already applied the switch locally. */
    private void selectAudioStreamOnPlexAsync(String streamId) {
        if (currentUrl == null || partId == null || partId.isEmpty()) return;
        Uri oldUri = Uri.parse(currentUrl);
        String token = oldUri.getQueryParameter("X-Plex-Token");
        if (token == null) return;
        String plexUrl = oldUri.getScheme() + "://" + oldUri.getAuthority();
        PlexHttp.runAsync(() -> {
            Uri putUri = Uri.parse(plexUrl + "/library/parts/" + partId).buildUpon()
                .appendQueryParameter("audioStreamID", streamId)
                .appendQueryParameter("allParts", "1")
                .appendQueryParameter("X-Plex-Token", token)
                .build();
            PlexHttp.putSync(putUri.toString());
            return null;
        }, ignored -> {});
    }

    /* Plex bakes the selected audio stream into the HLS transcode at session start, so
       switching tracks means re-requesting the same transcode URL with a new session -
       but a bare audioStreamID query param on that URL alone is NOT enough to make Plex
       actually mux the requested track, confirmed against a real server (it kept
       playing whatever was already selected regardless). The verified mechanism is
       marking the stream "selected" on the Part first via PUT /library/parts/<id>?
       audioStreamID=...&allParts=1 (plexUrl/token pulled off the existing transcode URL
       itself, partId from EXTRA_PART_ID - see native-bridge.js's buildPlaybackPayload) -
       the transcode decision then honors whatever's currently selected there. A fresh
       `session` id alone isn't enough either, even combined with that PUT - confirmed
       against a real server, it kept serving the OLD, still-warm session's audio
       regardless, and only actually switched once that old session had time to expire
       on its own (e.g. a full stop()+replay). Explicitly stopping the old session via
       GET /video/:/transcode/universal/stop?session=<id> makes the switch immediate
       instead of leaving it to Plex's own idle-timeout. Reuses the same "rebuild
       MediaItem, resume in place" mechanism applySubtitle uses above, including
       carrying over whatever subtitle is currently active (currentSubtitleUri et al,
       via currentSubtitleConfigOrNull) - a plain MediaItem.Builder with no
       subtitleConfigurations silently dropped it here otherwise, confirmed against a
       real device where the ABR monitor's own switchQualityCap (same rebuild shape) did
       exactly that with no user action and no visible error in between. Only reached
       now when switchAudioStreamLocally above couldn't apply the switch in place. */
    private void switchAudioStreamViaRestart(String streamId) {
        runSerializedReload(() -> doSwitchAudioStreamViaRestart(streamId));
    }

    private void doSwitchAudioStreamViaRestart(String streamId) {
        if (player == null || currentUrl == null) {
            onReloadComplete();
            return;
        }
        if (!isTranscodeUrl(currentUrl)) {
            currentAudioStreamId = streamId;
            requestJsReload("audioStreamID", streamId, player.getCurrentPosition());
            return;
        }
        long myGeneration = ++reloadGeneration;
        long resumeMs = player.getCurrentPosition();
        Uri oldUri = Uri.parse(currentUrl);
        String oldSessionId = oldUri.getQueryParameter("session");
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
        String newUrl = builder.build().toString();
        currentAudioStreamId = streamId;

        Runnable applyNewUrl = () -> {
            /* A newer switch (audio, version, or quality cap) was requested while this
               one's PUT/stop/decision round trip was still in flight - see
               reloadGeneration's own field comment. Discard this result rather than
               letting it stomp on whatever the newer switch already applied (or is
               about to). */
            if (myGeneration == reloadGeneration) {
                currentUrl = newUrl;
                MediaItem.Builder itemBuilder = new MediaItem.Builder().setUri(Uri.parse(currentUrl));
                MediaItem.SubtitleConfiguration subtitleConfig = currentSubtitleConfigOrNull();
                if (subtitleConfig != null) itemBuilder.setSubtitleConfigurations(java.util.Collections.singletonList(subtitleConfig));
                if (player != null) {
                    player.setMediaItem(itemBuilder.build(), resumeMs);
                    player.prepare();
                }
                if (abrMonitor != null) abrMonitor.notifyReload();
            }
            /* Frees the serialization slot for whatever's queued behind this reload -
               see reloadInFlight's own field comment. Deliberately LAST, not first: this
               can synchronously run a queued reload right here (runSerializedReload's own
               body), and that reload reads currentUrl/currentAudioStreamId fresh when it
               builds its own new URL - calling this before the state updates above ran
               was a real, confirmed bug: a queued ABR quality reload dequeued this way
               read the OLD (pre-switch) currentUrl, carried its stale audioStreamID
               forward into its own request, and - since it dispatched after and so held
               the newer generation - won and silently reverted the switch this very
               Runnable was supposed to commit. */
            onReloadComplete();
        };

        String token = oldUri.getQueryParameter("X-Plex-Token");
        boolean canSelectStream = partId != null && !partId.isEmpty() && token != null;
        boolean canStopOldSession = oldSessionId != null && token != null;
        if (token != null) {
            String plexUrl = oldUri.getScheme() + "://" + oldUri.getAuthority();
            PlexHttp.runAsync(() -> {
                if (canSelectStream) {
                    Uri putUri = Uri.parse(plexUrl + "/library/parts/" + partId).buildUpon()
                        .appendQueryParameter("audioStreamID", streamId)
                        .appendQueryParameter("allParts", "1")
                        .appendQueryParameter("X-Plex-Token", token)
                        .build();
                    PlexHttp.putSync(putUri.toString());
                }
                if (canStopOldSession) {
                    Uri stopUri = Uri.parse(plexUrl + "/video/:/transcode/universal/stop").buildUpon()
                        .appendQueryParameter("session", oldSessionId)
                        .appendQueryParameter("X-Plex-Token", token)
                        .build();
                    PlexHttp.getSync(stopUri.toString());
                }
                askDecision(newUrl);
                return null;
            }, ignored -> applyNewUrl.run());
        } else {
            applyNewUrl.run();
        }
    }

    /* Ensures at most one switchAudioStreamViaRestart/applyReloadedUrlAfterDecision
       reload is ever in flight against Plex - see reloadInFlight's own field comment
       for why this matters even though reloadGeneration already exists. A reload
       requested while one is already running is queued (overwriting any previously
       queued one, so a burst of rapid requests collapses to just the latest) rather
       than dispatched immediately alongside it. */
    private void runSerializedReload(Runnable reload) {
        if (reloadInFlight) {
            queuedReload = reload;
            return;
        }
        reloadInFlight = true;
        reload.run();
    }

    private void onReloadComplete() {
        reloadInFlight = false;
        Runnable next = queuedReload;
        queuedReload = null;
        if (next != null) runSerializedReload(next);
    }

    /* The actual, whole reason a restart-based switch (audio, version, or quality cap)
       never took effect until backing out and back in - confirmed against a real server
       (raspi-server), reading Plex's own /status/sessions mid-switch. Everything
       switchAudioStreamViaRestart above already does (the Part-selection PUT, the
       explicit old-session stop, a brand-new session id) was already correct and
       already being done, and STILL wasn't enough on its own: a plain
       /start.m3u8-equivalent MediaItem alone - even with all of that in place - kept
       ExoPlayer's request landing on the previous audio selection. Only once a
       /video/:/transcode/universal/decision request went out FIRST, with the exact same
       query params the MediaItem's URI carries, did the Media Decision Engine actually
       re-evaluate and the following playback honor the new selection immediately.
       Best-effort like the requests around it (see getSync's own IOException handling,
       swallowed by runAsync) - a failed decision call shouldn't block playback, it just
       means this particular attempt is back to relying on Plex's own eventual
       re-evaluation. Called from the same background thread PlexHttp.runAsync already
       submits switchAudioStreamViaRestart's PUT/stop work to, never from the caller
       (switchMediaVersion/switchQualityCap) directly - see their own call sites. */
    /* Real direct play (see stream-url.js's resolvePlaybackUrl) means currentUrl is a raw
       Plex file URL, not a /video/:/transcode/universal/... one - none of the query-param
       rewrites below (mediaIndex/maxVideoBitrate/audioStreamID/session) mean anything to
       Plex's static file endpoint, so doing them would silently no-op instead of actually
       switching anything. */
    private static boolean isTranscodeUrl(String url) {
        return url != null && url.contains("/video/:/transcode/universal/");
    }

    /* Hands a quality-cap/version/audio-track change back to JS instead of doing the
       query-param rewrite this class normally does itself - only reached when currentUrl
       is a real direct-play URL (see isTranscodeUrl above), since JS's
       stream-url.js/resolvePlaybackUrl is the one place that can correctly resolve a new
       URL for that case (it may stay direct play, e.g. a mediaVersion switch to another
       equally-playable version, or it may need to fall back to a genuine transcode - a
       raw file has no bitrate to cap and no server-side track mux for a non-default audio
       track).

       Bumps reloadGeneration itself and sends it to JS to carry back unchanged - the JS
       round trip (a decision fetch, up to ~1.5s) is a real gap another reload could land
       in, unlike this class's other async gaps which are all short native PlexHttp calls.
       applyPreResolvedUrl below compares the returned generation against the CURRENT one
       before applying, so a stale response from a superseded request can't stomp on
       whatever a newer one already did.

       Immediately frees this native reload's serialization slot (see
       runSerializedReload's own field comment) since native itself isn't doing anything
       further here - the eventual JS response applies as its own fresh reload via
       applyPreResolvedUrl, not a continuation of this one. */
    private void requestJsReload(String kind, String value, long resumeMs) {
        long myGeneration = ++reloadGeneration;
        if (listener != null) listener.onDirectPlayReloadRequested(kind, value, resumeMs, myGeneration);
        onReloadComplete();
    }

    /* Applies a URL JS already fully resolved (via resolvePlaybackUrl) - no askDecision
       call here, unlike applyReloadedUrlAfterDecision below, since JS's own decision call
       already happened before it computed this URL; asking again would be redundant and,
       for a genuine direct-play URL, meaningless (Plex's decision endpoint has nothing to
       do with a raw file path). Called from NativePlayerPlugin.applyReloadedUrl - the
       reply leg of requestJsReload above. `generation` is whatever requestJsReload sent
       JS at the start of this same round trip - see that method's own comment on why it
       has to be checked here, not just re-bumped. */
    public static void applyPreResolvedUrl(String newUrl, long resumeMs, long generation) {
        if (activeInstance != null) activeInstance.runSerializedReload(() -> activeInstance.doApplyPreResolvedUrl(newUrl, resumeMs, generation));
    }

    private void doApplyPreResolvedUrl(String newUrl, long resumeMs, long generation) {
        if (generation == reloadGeneration) {
            currentUrl = newUrl;
            MediaItem.Builder itemBuilder = new MediaItem.Builder().setUri(Uri.parse(currentUrl));
            MediaItem.SubtitleConfiguration subtitleConfig = currentSubtitleConfigOrNull();
            if (subtitleConfig != null) itemBuilder.setSubtitleConfigurations(java.util.Collections.singletonList(subtitleConfig));
            if (player != null) {
                player.setMediaItem(itemBuilder.build(), resumeMs);
                player.prepare();
            }
            if (abrMonitor != null) abrMonitor.notifyReload();
        }
        onReloadComplete();
    }

    private static void askDecision(String newUrl) throws IOException {
        /* Plain string replacement, not Uri.Builder.path() - confirmed the actual reason
           this silently never worked on Android despite working on web: path() re-encodes
           its argument via Uri.encode(path, "/"), which escapes the literal ":" in
           "/video/:/transcode/universal/decision" into "%3A", turning this into a 404
           that askDecision's own caller (wrapped in PlexHttp.runAsync's catch-all) just
           swallowed. newUrl is always a /start.m3u8 URL built from this same endpoint
           family (see switchAudioStreamViaRestart/applyReloadedUrlAfterDecision), so a
           literal substring swap is safe and sidesteps Uri.Builder entirely. */
        String decisionUrl = newUrl.replace(
            "/video/:/transcode/universal/start.m3u8",
            "/video/:/transcode/universal/decision"
        );
        PlexHttp.getSync(decisionUrl);
    }

    /* Same "rebuild the transcode URL, resume in place" mechanism as switchAudioStream
       above - Plex bakes the selected Media[] entry into the transcode at session
       start via the mediaIndex param, so switching versions means re-requesting the
       same path with a new one, a fresh session id, and an offset resuming where
       playback left off. Called from PlayerUiHelper's Video Quality > Version menu.
       Now asks Plex to re-decide first (see askDecision's own header comment on
       switchAudioStreamViaRestart) - the same MDE staleness that broke audio switching
       applies to any param baked into the transcode at session start, mediaIndex
       included, not just audioStreamID. */
    void switchMediaVersion(int mediaIndex) {
        runSerializedReload(() -> doSwitchMediaVersion(mediaIndex));
    }

    private void doSwitchMediaVersion(int mediaIndex) {
        if (player == null || currentUrl == null) {
            onReloadComplete();
            return;
        }
        if (!isTranscodeUrl(currentUrl)) {
            currentMediaIndex = mediaIndex;
            requestJsReload("mediaVersion", String.valueOf(mediaIndex), player.getCurrentPosition());
            return;
        }
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
        String newUrl = builder.build().toString();
        currentMediaIndex = mediaIndex;
        applyReloadedUrlAfterDecision(newUrl, resumeMs);
    }

    /* Same mechanism again for the bitrate cap (Plex's maxVideoBitrate param) - a null
       kbps (Quality Cap's "Original" option) means the param is dropped entirely
       rather than sent as some sentinel value, matching stream-url.js's
       buildStreamUrl on the web leg. Called from PlayerUiHelper's Video Quality >
       Quality Cap menu, and autonomously by QualityAbrMonitor - the latter is exactly
       why carrying the active subtitle forward (see switchAudioStream's own comment)
       matters most here: this can fire with no user action at all, an arbitrary amount
       of time after a subtitle was applied. Also asks Plex to re-decide first, same
       reasoning as switchMediaVersion above. */
    void switchQualityCap(Integer kbps) {
        runSerializedReload(() -> doSwitchQualityCap(kbps));
    }

    private void doSwitchQualityCap(Integer kbps) {
        if (player == null || currentUrl == null) {
            onReloadComplete();
            return;
        }
        if (!isTranscodeUrl(currentUrl)) {
            qualityCapKbps = kbps;
            requestJsReload("qualityCap", kbps != null ? String.valueOf(kbps) : null, player.getCurrentPosition());
            return;
        }
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
        String newUrl = builder.build().toString();
        qualityCapKbps = kbps;
        applyReloadedUrlAfterDecision(newUrl, resumeMs);
    }

    /* Shared by switchMediaVersion/switchQualityCap above: ask Plex to re-decide against
       the new URL's params, then rebuild the MediaItem and resume in place - same
       "decision before start" sequencing switchAudioStreamViaRestart's own PUT/stop
       block already does for audio, just with no Part-selection PUT or old-session stop
       needed here (mediaIndex/maxVideoBitrate aren't a Part-level "selected" stream, and
       the old session dies on its own the moment ExoPlayer stops requesting its
       segments). Falls back to applying immediately if this URL carries no token to ask
       with - same "no data, no-op the network step" shape as switchAudioStreamViaRestart's
       own canSelectStream/canStopOldSession checks. */
    private void applyReloadedUrlAfterDecision(String newUrl, long resumeMs) {
        long myGeneration = ++reloadGeneration;
        String token = Uri.parse(newUrl).getQueryParameter("X-Plex-Token");
        Runnable apply = () -> {
            /* See reloadGeneration's own field comment - a newer switch superseded this
               one while its decision request was still in flight. */
            if (myGeneration == reloadGeneration) {
                currentUrl = newUrl;
                MediaItem.Builder itemBuilder = new MediaItem.Builder().setUri(Uri.parse(currentUrl));
                MediaItem.SubtitleConfiguration subtitleConfig = currentSubtitleConfigOrNull();
                if (subtitleConfig != null) itemBuilder.setSubtitleConfigurations(java.util.Collections.singletonList(subtitleConfig));
                if (player != null) {
                    player.setMediaItem(itemBuilder.build(), resumeMs);
                    player.prepare();
                }
                if (abrMonitor != null) abrMonitor.notifyReload();
            }
            /* Frees the serialization slot for whatever's queued behind this reload -
               see reloadInFlight's own field comment, and doSwitchAudioStreamViaRestart's
               applyNewUrl for why this has to run LAST, after the state updates above,
               not before them. */
            onReloadComplete();
        };
        if (token != null) {
            PlexHttp.runAsync(() -> {
                askDecision(newUrl);
                return null;
            }, ignored -> apply.run());
        } else {
            apply.run();
        }
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

    /* Toggled by the hamburger menu's "Lock" row (locked=true, see
       PlayerUiHelper.showPlayerMenu) and the lock overlay's own long-press gesture
       (locked=false) - see PlayerUiHelper.buildLockOverlay. Locking forces every fading
       control hidden via the same setControlsVisible lockstep-fade the inactivity timer
       uses, then reveals the overlay on top of everything to intercept all further
       touches; unlocking reverses both and briefly reveals the chrome again, same as any
       other action that calls showControlsTemporarily. */
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

    /* Confirmed via logcat (SM_X710) that live PiP playback only ever reaches onPause(),
       never onStop() - the pinned window keeps the activity visible, just not focused.
       onStop() firing at all therefore means either a normal finish (isFinishing() already
       true, nothing to do) or the activity just went fully invisible without finishing -
       which on this device is exactly what happens when the user taps PiP's system "X":
       it calls onStop() but never finish()/onDestroy(), leaving the ExoPlayer instance
       alive and playing audio with nothing on screen. Finishing here closes that gap for
       both that case and plain backgrounding (e.g. Home/Recents) without PiP - this app
       has no background-audio/MediaSession story, so "not visible and not pinned" should
       always mean playback is over. */
    @Override
    protected void onStop() {
        super.onStop();
        /* Captured before finish() below - onPictureInPictureModeChanged(false) hasn't
           run yet at this point (confirmed via logcat: it fires right after this onStop,
           not before), so isCurrentlyPip is still whatever it was while pinned. Only a
           pip-close should also tear down MainActivity's task - a plain fullscreen
           back-out reaches this same finish() a line below with isCurrentlyPip already
           false, and MainActivity is expected to resume normally there, not disappear. */
        boolean wasPinned = isCurrentlyPip;
        if (!isFinishing()) {
            finish();
        }
        if (wasPinned) {
            MainActivity.finishIfRunning();
        }
    }

    @Override
    protected void onDestroy() {
        stopProgressLoop();
        /* Best-effort final ping - see reportNativeTimeline's own header comment for why
           this leg exists at all. Native, not JS, for the same WebView-suspended-while-
           foregrounded reason every other native timeline ping in this file is. */
        reportNativeTimeline("stopped");
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
        PlayerUiHelper.closePlayerMenu(this);
        PlayerUiHelper.closeEpisodeListMenu(this);
        PlayerUiHelper.closeChapterListMenu(this);
        PlayerUiHelper.closeAudioSubtitlesMenu(this);
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
