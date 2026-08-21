package com.mpotrykus.prism;

import android.content.Intent;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.media.MediaFormat;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativePlayer")
public class NativePlayerPlugin extends Plugin implements PlayerActivity.PlaybackListener {

    @Override
    public void load() {
        super.load();
        PlayerActivity.setListener(this);
    }

    /* {url, startPositionMs, shaderType, title, ...} fields both play() and
       switchTitle() below pull off the call the same way - shared so a future field
       added to one Java-side consumer doesn't silently go missing from the other. */
    private static final class PlaybackParams {
        String url;
        long startPositionMs;
        JSArray chapters;
        JSArray audioStreams;
        String partId;
        JSArray mediaVersions;
        Integer currentMediaIndex;
        Integer qualityCapKbps;
        String bifUrl;
        String shaderType;
        String title;
        String episodeTitle;
        Integer year;
        Integer seasonNumber;
        Integer episodeNumber;
        Integer queueLength;
        Integer queueIndex;
    }

    private static PlaybackParams parsePlaybackParams(PluginCall call) {
        PlaybackParams p = new PlaybackParams();
        p.url = call.getString("url");
        p.startPositionMs = call.getLong("startPositionMs", 0L);
        p.chapters = call.getArray("chapters");
        p.audioStreams = call.getArray("audioStreams");
        p.partId = call.getString("partId");
        p.mediaVersions = call.getArray("mediaVersions");
        p.currentMediaIndex = call.getInt("currentMediaIndex");
        p.qualityCapKbps = call.getInt("qualityCapKbps");
        p.bifUrl = call.getString("bifUrl");
        /* shaderEnabled/upscaleStrength/upscaleAuto are NOT read from the call here any
           more - PlayerActivity now owns them as its own SharedPreferences-persisted
           state (see that class's PREF_UPSCALE_ENABLED and friends), same immediate-
           persistence model as colorBoostSaturationEnabled/colorBoostSaturationStrength/
           colorBoostSaturationAuto and the Contrast equivalents, which never traveled
           through this plugin either. */
        p.shaderType = call.getString("shaderType", "live_action");
        p.title = call.getString("title", "");
        p.episodeTitle = call.getString("episodeTitle");
        p.year = call.getInt("year");
        p.seasonNumber = call.getInt("seasonNumber");
        p.episodeNumber = call.getInt("episodeNumber");
        p.queueLength = call.getInt("queueLength");
        p.queueIndex = call.getInt("queueIndex");
        return p;
    }

    @PluginMethod
    public void play(PluginCall call) {
        PlaybackParams p = parsePlaybackParams(call);
        if (p.url == null || p.url.isEmpty()) {
            call.reject("Missing required parameter: url");
            return;
        }

        Intent intent = new Intent(getContext(), PlayerActivity.class);
        intent.putExtra(PlayerActivity.EXTRA_URL, p.url);
        intent.putExtra(PlayerActivity.EXTRA_START_POSITION_MS, p.startPositionMs);
        intent.putExtra(PlayerActivity.EXTRA_SHADER_TYPE, p.shaderType);
        intent.putExtra(PlayerActivity.EXTRA_TITLE, p.title);
        if (p.episodeTitle != null && !p.episodeTitle.isEmpty()) intent.putExtra(PlayerActivity.EXTRA_EPISODE_TITLE, p.episodeTitle);
        if (p.year != null) intent.putExtra(PlayerActivity.EXTRA_YEAR, p.year);
        if (p.seasonNumber != null) intent.putExtra(PlayerActivity.EXTRA_SEASON_NUMBER, p.seasonNumber);
        if (p.episodeNumber != null) intent.putExtra(PlayerActivity.EXTRA_EPISODE_NUMBER, p.episodeNumber);
        if (p.queueLength != null) intent.putExtra(PlayerActivity.EXTRA_QUEUE_LENGTH, p.queueLength);
        if (p.queueIndex != null) intent.putExtra(PlayerActivity.EXTRA_QUEUE_INDEX, p.queueIndex);
        if (p.chapters != null) {
            intent.putExtra(PlayerActivity.EXTRA_CHAPTERS_JSON, p.chapters.toString());
        }
        if (p.bifUrl != null && !p.bifUrl.isEmpty()) {
            intent.putExtra(PlayerActivity.EXTRA_BIF_URL, p.bifUrl);
        }
        if (p.audioStreams != null) {
            intent.putExtra(PlayerActivity.EXTRA_AUDIO_STREAMS_JSON, p.audioStreams.toString());
        }
        if (p.partId != null && !p.partId.isEmpty()) {
            intent.putExtra(PlayerActivity.EXTRA_PART_ID, p.partId);
        }
        if (p.mediaVersions != null) {
            intent.putExtra(PlayerActivity.EXTRA_MEDIA_VERSIONS_JSON, p.mediaVersions.toString());
        }
        if (p.currentMediaIndex != null) intent.putExtra(PlayerActivity.EXTRA_CURRENT_MEDIA_INDEX, p.currentMediaIndex);
        if (p.qualityCapKbps != null) intent.putExtra(PlayerActivity.EXTRA_QUALITY_CAP_KBPS, p.qualityCapKbps);

        startActivityForResult(call, intent, "onPlaybackActivityResult");
    }

    @ActivityCallback
    private void onPlaybackActivityResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        call.resolve();
    }

    /* In-place counterpart to play() above - swaps PlayerActivity's currently playing
       title without finish()-ing/relaunching it (see PlayerActivity.loadTitle's own
       header comment for why that matters: a fresh Activity per title made prev/next
       visibly swipe the whole window out and back in). Resolves immediately rather than
       via startActivityForResult/onPlaybackActivityResult - there's no new Activity
       result to wait on since none launches. */
    @PluginMethod
    public void switchTitle(PluginCall call) {
        PlaybackParams p = parsePlaybackParams(call);
        if (p.url == null || p.url.isEmpty()) {
            call.reject("Missing required parameter: url");
            return;
        }
        PlayerActivity.loadTitle(p.url, p.startPositionMs, p.shaderType, p.title, p.episodeTitle,
            p.year, p.seasonNumber, p.episodeNumber, p.queueLength, p.queueIndex,
            p.chapters != null ? p.chapters.toString() : null,
            p.bifUrl,
            p.audioStreams != null ? p.audioStreams.toString() : null,
            p.partId,
            p.mediaVersions != null ? p.mediaVersions.toString() : null,
            p.currentMediaIndex, p.qualityCapKbps);
        call.resolve();
    }

    @PluginMethod
    public void pause(PluginCall call) {
        PlayerActivity.pause();
        call.resolve();
    }

    @PluginMethod
    public void resume(PluginCall call) {
        PlayerActivity.resume();
        call.resolve();
    }

    @PluginMethod
    public void seek(PluginCall call) {
        Long positionMs = call.getLong("positionMs");
        if (positionMs == null) {
            call.reject("Missing required parameter: positionMs");
            return;
        }
        PlayerActivity.seek(positionMs);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        PlayerActivity.stopPlayback();
        call.resolve();
    }

    @PluginMethod
    public void setPlaybackSpeed(PluginCall call) {
        Float speed = call.getFloat("speed");
        if (speed == null) {
            call.reject("Missing required parameter: speed");
            return;
        }
        PlayerActivity.setPlaybackSpeed(speed);
        call.resolve();
    }

    @PluginMethod
    public void showSkipButton(PluginCall call) {
        String label = call.getString("label");
        Long seekToMs = call.getLong("seekToMs");
        if (label == null || seekToMs == null) {
            call.reject("Missing required parameter: label and/or seekToMs");
            return;
        }
        PlayerActivity.showSkipButton(label, seekToMs);
        call.resolve();
    }

    @PluginMethod
    public void hideSkipButton(PluginCall call) {
        PlayerActivity.hideSkipButton();
        call.resolve();
    }

    /* Counterpart to onEpisodeListRequested below - JS resolves the queue's Plex
       metadata itself (episode-list.js's getQueueItems/formatEpisodeListItem, shared
       with the web overlay) and hands this pre-formatted JSON blob over to render, same
       "JS interprets Plex's protocol once, Java just renders it" split chapters/
       audioStreams already use (see parsePlaybackParams above). */
    @PluginMethod
    public void showEpisodeList(PluginCall call) {
        JSArray items = call.getArray("items");
        PlayerActivity.showEpisodeList(items != null ? items.toString() : null);
        call.resolve();
    }

    /* Takes the raw .srt TEXT, not a bare URL - PlayerActivity's Sync +/- control needs
       the original timestamps cached natively so every click can re-shift and rewrite a
       local file without a JS round trip back to Plex for each one. */
    @PluginMethod
    public void setSubtitle(PluginCall call) {
        String text = call.getString("text");
        if (text == null || text.isEmpty()) {
            call.reject("Missing required parameter: text");
            return;
        }
        String languageCode = call.getString("languageCode", "en");
        String mimeType = call.getString("mimeType", "application/x-subrip");
        PlayerActivity.setSubtitleText(text, languageCode, mimeType);
        call.resolve();
    }

    /* JS restoring a remembered Sync offset (subtitle-store.js) right after a fresh
       setSubtitle call above - same apply-then-restore sequence chrome.js's own
       applyRememberedSubtitle uses on the web/Xbox leg. Absolute, not a delta - unlike
       PlayerUiHelper's own Sync +/- buttons (which call PlayerActivity.
       adjustSubtitleOffset directly, no bridge involved), JS already knows the exact
       value it wants restored. */
    @PluginMethod
    public void setSubtitleOffset(PluginCall call) {
        Long offsetMs = call.getLong("offsetMs");
        if (offsetMs == null) {
            call.reject("Missing required parameter: offsetMs");
            return;
        }
        PlayerActivity.setSubtitleOffsetMs(offsetMs);
        call.resolve();
    }

    /* Counterpart to onSubtitleSearchRequested below - JS resolves the actual Plex
       subtitle search (plex-subtitles.js's search(), shared with the web overlay)
       and hands this pre-formatted JSON blob over to render, same "JS interprets the
       external protocol once, Java just renders it" split showEpisodeList/
       parsePlaybackParams already use. */
    @PluginMethod
    public void showSubtitleResults(PluginCall call) {
        JSArray items = call.getArray("items");
        String error = call.getString("error");
        PlayerActivity.showSubtitleResults(items != null ? items.toString() : null, error);
        call.resolve();
    }

    /* Success/failure legs of onSubtitleSelectRequested below - arrive after JS has
       already called setSubtitle (the actual attach) or failed trying to. Kept separate
       from setSubtitle itself so that method's signature stays the same one the dead-
       but-kept-correct web/chrome.js Android branch already calls. */
    @PluginMethod
    public void notifySubtitleApplied(PluginCall call) {
        String fileId = call.getString("fileId");
        String label = call.getString("label");
        PlayerActivity.notifySubtitleApplied(fileId, label);
        call.resolve();
    }

    @PluginMethod
    public void notifySubtitleApplyFailed(PluginCall call) {
        String fileId = call.getString("fileId");
        String message = call.getString("message", "Unknown error");
        PlayerActivity.notifySubtitleApplyFailed(fileId, message);
        call.resolve();
    }

    /* Queried once by native-bridge.js's playNative, before PlayerActivity even exists
       yet (the play() call that launches it hasn't been made) - reads straight from
       SharedPreferences via PlayerActivity's static accessors rather than an
       activeInstance field for exactly that reason. Later changes (the More menu's
       Auto-Play/Auto-Skip Intro & Credits rows) reach JS live instead, via
       onAutoSkipSettingsChanged below - this is only the cold-start read. */
    @PluginMethod
    public void getAutoSkipSettings(PluginCall call) {
        JSObject result = new JSObject();
        result.put("autoPlayEnabled", PlayerActivity.getAutoPlayEnabledPref(getContext()));
        result.put("autoSkipIntroCreditsEnabled", PlayerActivity.getAutoSkipIntroCreditsEnabledPref(getContext()));
        call.resolve(result);
    }

    /* Backs core/platform.js's primeDecodeCapabilities(), called once at app boot to widen what's honestly
       advertised to Plex (see stream-url.js's clientCapabilities) beyond the
       conservative h264-1080p floor. A pure device query - doesn't touch
       PlayerActivity/playback state at all. */
    @PluginMethod
    public void getDecodeCapabilities(PluginCall call) {
        JSObject result = new JSObject();
        result.put("hevcMain10_2160", deviceSupportsHevcMain10());
        call.resolve(result);
    }

    private static boolean deviceSupportsHevcMain10() {
        MediaCodecList codecList = new MediaCodecList(MediaCodecList.REGULAR_CODECS);
        for (MediaCodecInfo info : codecList.getCodecInfos()) {
            if (info.isEncoder()) continue;
            for (String type : info.getSupportedTypes()) {
                if (!type.equalsIgnoreCase(MediaFormat.MIMETYPE_VIDEO_HEVC)) continue;
                MediaCodecInfo.CodecCapabilities caps = info.getCapabilitiesForType(type);
                for (MediaCodecInfo.CodecProfileLevel level : caps.profileLevels) {
                    if (level.profile == MediaCodecInfo.CodecProfileLevel.HEVCProfileMain10) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    @Override
    public void onProgress(long positionMs, long durationMs) {
        JSObject data = new JSObject();
        data.put("positionMs", positionMs);
        data.put("durationMs", durationMs);
        notifyListeners("progress", data);
    }

    @Override
    public void onEnded() {
        notifyListeners("ended", new JSObject());
    }

    @Override
    public void onError(String message) {
        JSObject data = new JSObject();
        data.put("message", message != null ? message : "Unknown playback error");
        notifyListeners("error", data);
    }

    @Override
    public void onStopped(long positionMs) {
        JSObject data = new JSObject();
        data.put("positionMs", positionMs);
        notifyListeners("stopped", data);
    }

    @Override
    public void onTitleNavRequested(int newIndex) {
        JSObject data = new JSObject();
        data.put("index", newIndex);
        notifyListeners("titleNav", data);
    }

    /* PlayerUiHelper's Episodes button has no Plex metadata to show yet when tapped -
       this just reports "the user wants to see the queue" back to JS, which resolves
       the actual episode list and calls showEpisodeList() above with the result. Empty
       payload, unlike onTitleNavRequested's index - JS already has its own queueRatingKeys/
       session copy, nothing needs to travel with the request itself. */
    @Override
    public void onEpisodeListRequested() {
        notifyListeners("episodeListRequested", new JSObject());
    }

    /* PlayerUiHelper's Audio & Subtitles search button has no Plex subtitle result of
       its own to show yet when tapped - this reports the typed query back to JS, which
       resolves the actual search (plex-subtitles.js's search()) and calls
       showSubtitleResults() above with the result. */
    @Override
    public void onSubtitleSearchRequested(String query) {
        JSObject data = new JSObject();
        data.put("query", query != null ? query : "");
        notifyListeners("subtitleSearchRequested", data);
    }

    /* A subtitle result row tap - fileId is opaque to Java, JS resolves the actual
       subtitle text from Plex (plex-subtitles.js's download()) and calls setSubtitle
       above, then notifySubtitleApplied/notifySubtitleApplyFailed with the outcome. */
    @Override
    public void onSubtitleSelectRequested(String fileId, String label, String languageCode) {
        JSObject data = new JSObject();
        data.put("fileId", fileId);
        data.put("label", label);
        data.put("languageCode", languageCode);
        notifyListeners("subtitleSelectRequested", data);
    }

    /* The "Off" row (PlayerActivity.clearSubtitleTrack) applies fully natively with no
       JS round trip needed for the apply itself, but JS still needs to hear about it -
       it remembers the last-applied subtitle per title (subtitle-store.js) to
       auto-reapply on the next play, and without this it would never learn the user
       turned it back off, silently reapplying every time this title plays again. */
    @Override
    public void onSubtitleCleared() {
        notifyListeners("subtitleCleared", new JSObject());
    }

    /* PlayerUiHelper's Sync +/- buttons (PlayerActivity.adjustSubtitleOffset) apply
       fully natively too, same "notify JS afterward" reasoning as onSubtitleCleared
       above - JS persists the offset per title (subtitle-store.js's
       setAppliedOffsetMs) to restore on the next play (setSubtitleOffset above). */
    @Override
    public void onSubtitleOffsetChanged(long offsetMs) {
        JSObject data = new JSObject();
        data.put("offsetMs", offsetMs);
        notifyListeners("subtitleOffsetChanged", data);
    }

    /* PlayerUiHelper's Quality Cap/Version/Audio Track menus normally rewrite the
       transcode URL's query params entirely natively - this fires only when
       PlayerActivity finds currentUrl is a real direct-play file URL instead, where that
       rewrite would silently mean nothing to Plex. JS resolves a real new URL (via
       stream-url.js's resolvePlaybackUrl, native-bridge.js's own listener for this event)
       and calls applyReloadedUrl below with the result - the `generation` value must
       travel back unchanged, see PlayerActivity.requestJsReload's own comment on why. */
    @Override
    public void onDirectPlayReloadRequested(String kind, String value, long resumeMs, long generation) {
        JSObject data = new JSObject();
        data.put("kind", kind);
        data.put("value", value);
        data.put("resumeMs", resumeMs);
        data.put("generation", generation);
        notifyListeners("directPlayReloadRequested", data);
    }

    /* Live counterpart to getAutoSkipSettings above - fired from PlayerActivity's
       setAutoPlayEnabled/setAutoSkipIntroCreditsEnabled whenever the More menu's rows
       change either flag mid-session, so native-bridge.js's local mirror of both never
       goes stale for the rest of that playback. */
    @Override
    public void onAutoSkipSettingsChanged(boolean autoPlayEnabled, boolean autoSkipIntroCreditsEnabled) {
        JSObject data = new JSObject();
        data.put("autoPlayEnabled", autoPlayEnabled);
        data.put("autoSkipIntroCreditsEnabled", autoSkipIntroCreditsEnabled);
        notifyListeners("autoSkipSettingsChanged", data);
    }

    /* Reply leg of onDirectPlayReloadRequested above. */
    @PluginMethod
    public void applyReloadedUrl(PluginCall call) {
        String url = call.getString("url");
        Long startPositionMs = call.getLong("startPositionMs", 0L);
        Long generation = call.getLong("generation");
        if (url == null || generation == null) {
            call.reject("Missing required parameter: url and/or generation");
            return;
        }
        PlayerActivity.applyPreResolvedUrl(url, startPositionMs, generation);
        call.resolve();
    }
}
