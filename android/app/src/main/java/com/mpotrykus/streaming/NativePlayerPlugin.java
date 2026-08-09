package com.mpotrykus.streaming;

import android.content.Intent;
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
        p.mediaVersions = call.getArray("mediaVersions");
        p.currentMediaIndex = call.getInt("currentMediaIndex");
        p.qualityCapKbps = call.getInt("qualityCapKbps");
        p.bifUrl = call.getString("bifUrl");
        /* shaderEnabled/upscaleStrength/upscaleAuto are NOT read from the call here any
           more - PlayerActivity now owns them as its own SharedPreferences-persisted
           state (see that class's PREF_UPSCALE_ENABLED and friends), same immediate-
           persistence model as colorBoostEnabled/colorBoostStrength/colorBoostAuto,
           which never traveled through this plugin either. */
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
       local file without a JS round trip back to OpenSubtitles for each one. */
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

    /* Counterpart to onSubtitleSearchRequested below - JS resolves the actual
       OpenSubtitles search (opensubtitles.js's search(), shared with the web overlay)
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

    /* PlayerUiHelper's Audio & Subtitles search button has no OpenSubtitles result of
       its own to show yet when tapped - this reports the typed query back to JS, which
       resolves the actual search (opensubtitles.js's search()) and calls
       showSubtitleResults() above with the result. */
    @Override
    public void onSubtitleSearchRequested(String query) {
        JSObject data = new JSObject();
        data.put("query", query != null ? query : "");
        notifyListeners("subtitleSearchRequested", data);
    }

    /* A subtitle result row tap - fileId is opaque to Java, JS resolves the real
       download link (opensubtitles.js's resolveDownloadLink()) and calls setSubtitle
       above, then notifySubtitleApplied/notifySubtitleApplyFailed with the outcome. */
    @Override
    public void onSubtitleSelectRequested(String fileId, String label, String languageCode) {
        JSObject data = new JSObject();
        data.put("fileId", fileId);
        data.put("label", label);
        data.put("languageCode", languageCode);
        notifyListeners("subtitleSelectRequested", data);
    }
}
