using Microsoft.Web.WebView2.Core;
using System;
using Windows.Data.Json;

namespace PrismXbox.Player
{
    /// <summary>
    /// The JS↔native transport for playback. Mirrors the method and event names of Android's
    /// NativePlayerPlugin (see src/player/native-bridge.js and src/player/xbox-bridge.js) so the two
    /// platforms present one contract rather than two.
    ///
    /// Every non-obvious choice here is a lesson from the Phase 0 spikes or the Android bridge, and
    /// each is cheap to keep and expensive to rediscover:
    ///
    /// - **Inbound messages arrive as JSON strings, not objects.** An object posted with
    ///   <c>chrome.webview.postMessage</c> silently never reaches WebMessageReceived on the Xbox
    ///   WebView2 runtime - no error on either side. So both forms are accepted here and the JS side
    ///   always stringifies.
    /// - **<see cref="JsonObject.GetNamedString(string, string)"/> throws on a null default**, because a
    ///   WinRT HSTRING cannot be null. Every read below defaults to "" instead. This once discarded
    ///   every message that arrived, which looked identical to the channel being dead.
    /// - **The whole handler is wrapped**, because an exception thrown out of a WinRT event handler is
    ///   swallowed at the ABI boundary and the handler simply appears never to have run.
    /// - **Numeric Plex ids are read as strings.** Plex's partId and audio stream ids are JSON numbers;
    ///   reading one as a string is what silently produced null on the Android bridge and defeated four
    ///   rounds of otherwise-correct fixes. The JS side String()-coerces them, and
    ///   <see cref="ReadId"/> accepts either shape rather than trusting that.
    /// </summary>
    internal sealed class PlayerBridge
    {
        private readonly CoreWebView2 webView;
        private readonly NativePlayerHost host;
        private readonly Action<string> log;

        public PlayerBridge(CoreWebView2 webView, NativePlayerHost host, Action<string> log)
        {
            this.webView = webView;
            this.host = host;
            this.log = log ?? (_ => { });
            webView.WebMessageReceived += OnWebMessageReceived;
        }

        /// <summary>Native → JS. Called by <see cref="NativePlayerHost"/> for every event.</summary>
        public void Emit(string eventName, string jsonParams)
        {
            string message = $"{{\"event\":\"{eventName}\",\"params\":{jsonParams}}}";
            try
            {
                webView.PostWebMessageAsJson(message);
            }
            catch (Exception ex)
            {
                // Logging the exact assembled message (not just the HResult) is what actually
                // found the 2026-08-20 contentAnalysis bug - a mis-lowered interpolation hole
                // silently leaked its own format specifier ("R") into the JSON as a literal,
                // unquoted token (see NativePlayerHost.cs's ContentAnalysis handler) - worth
                // keeping permanently, not just for that one bug: any future "why did this
                // specific emit fail" question needs the real string, not just the HResult.
                log($"emit {eventName} failed: 0x{ex.HResult:X8} message={message}");
            }
        }

        private void OnWebMessageReceived(CoreWebView2 sender, CoreWebView2WebMessageReceivedEventArgs args)
        {
            try
            {
                Dispatch(args);
            }
            catch (Exception ex)
            {
                log($"bridge handler threw: {ex.GetType().Name} / {ex.Message}");
            }
        }

        private void Dispatch(CoreWebView2WebMessageReceivedEventArgs args)
        {
            string payload;
            try
            {
                payload = args.TryGetWebMessageAsString();
            }
            catch (Exception)
            {
                payload = args.WebMessageAsJson;
            }

            if (!JsonObject.TryParse(payload, out JsonObject root)) return;

            // Messages carrying "type" instead of "method" belong to the Phase 0 diagnostic harness,
            // which shares this channel; ignore rather than log, so they don't look like errors.
            string method = root.GetNamedString("method", "");
            if (method.Length == 0) return;

            JsonObject p = root.ContainsKey("params") && root["params"].ValueType == JsonValueType.Object
                ? root.GetNamedObject("params")
                : new JsonObject();

            switch (method)
            {
                case "play":
                    host.Play(p.GetNamedString("url", ""), ReadLong(p, "startPositionMs"),
                        p.GetNamedBoolean("isHdr", false), p.GetNamedBoolean("isDirectPlay", false));
                    break;
                case "switchTitle":
                    host.SwitchTitle(p.GetNamedString("url", ""), ReadLong(p, "startPositionMs"),
                        p.GetNamedBoolean("isHdr", false), p.GetNamedBoolean("isDirectPlay", false));
                    break;
                case "stop":
                    host.Stop();
                    break;
                case "pause":
                    host.Pause();
                    break;
                case "resume":
                    host.Resume();
                    break;
                case "seek":
                    host.Seek(ReadLong(p, "positionMs"));
                    break;
                case "setVolume":
                    host.SetVolume(p.GetNamedNumber("volume", 1));
                    break;
                case "setMuted":
                    host.SetMuted(p.GetNamedBoolean("muted", false));
                    break;
                case "setPlaybackSpeed":
                    host.SetPlaybackSpeed(p.GetNamedNumber("speed", 1));
                    break;
                case "setStretch":
                    host.SetStretch(p.GetNamedString("mode", "fit"));
                    break;
                case "setShaderEffect":
                    host.SetShaderEffect(
                        p.GetNamedBoolean("enabled", false),
                        p.GetNamedString("shaderType", ""),
                        p.GetNamedNumber("strength", 0),
                        p.GetNamedBoolean("auto", false));
                    break;
                case "setColorBoost":
                    host.SetColorBoost(
                        p.GetNamedBoolean("saturationEnabled", false),
                        p.GetNamedBoolean("contrastEnabled", false),
                        p.GetNamedNumber("saturationStrength", 0),
                        p.GetNamedNumber("contrastStrength", 0),
                        p.GetNamedBoolean("saturationAuto", false),
                        p.GetNamedBoolean("contrastAuto", false));
                    break;
                case "setAmbientLighting":
                    host.SetAmbientLighting(p.GetNamedBoolean("enabled", false));
                    break;
                case "setAiUpscaling":
                    host.SetAiUpscaling(
                        p.GetNamedBoolean("enabled", false),
                        p.GetNamedString("preset", ""));
                    break;
                case "switchAudioTrackLocally":
                    host.SwitchAudioTrackLocally((int)ReadLong(p, "index"));
                    break;
                default:
                    log($"unhandled bridge method: {method}");
                    break;
            }
        }

        private static long ReadLong(JsonObject obj, string key)
        {
            if (!obj.ContainsKey(key)) return 0;
            IJsonValue value = obj[key];
            switch (value.ValueType)
            {
                case JsonValueType.Number: return (long)value.GetNumber();
                // Tolerated deliberately: a caller that String()-coerced a number (the rule that fixed
                // the Android partId bug) must not be punished for it here.
                case JsonValueType.String: return long.TryParse(value.GetString(), out long parsed) ? parsed : 0;
                default: return 0;
            }
        }

        /// <summary>
        /// Reads an id that may arrive as either a JSON string or a JSON number, always returning a
        /// string. Not currently called - it exists for the audio-track and media-version switching the
        /// next increment adds, and is written now because getting this wrong is the single most
        /// expensive bug this project has hit: <c>PluginCall.getString()</c> returned null for Plex's
        /// numeric <c>Part.id</c> on Android, with no error, and that defeated four rounds of correct
        /// fixes to the surrounding logic before anyone looked here.
        /// </summary>
        private static string ReadId(JsonObject obj, string key)
        {
            if (!obj.ContainsKey(key)) return null;
            IJsonValue value = obj[key];
            switch (value.ValueType)
            {
                case JsonValueType.String: return value.GetString();
                case JsonValueType.Number: return ((long)value.GetNumber()).ToString();
                default: return null;
            }
        }
    }
}
