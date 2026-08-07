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
            p.audioStreams != null ? p.audioStreams.toString() : null);
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

    @PluginMethod
    public void setSubtitle(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("Missing required parameter: url");
            return;
        }
        String languageCode = call.getString("languageCode", "en");
        String mimeType = call.getString("mimeType", "application/x-subrip");
        PlayerActivity.setSubtitleUrl(url, languageCode, mimeType);
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
}
