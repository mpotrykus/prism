using System;
using System.Threading.Tasks;
using Windows.Media.Core;
using Windows.Media.Playback;
using Windows.Media.Streaming.Adaptive;
using Windows.UI.Xaml.Controls;

namespace PrismXbox.Player
{
    /// <summary>
    /// Phase 0 hardware spike. Temporary by design - it exists to answer, on a real console,
    /// whether the MediaFoundation stack can actually be the Xbox native player before any of
    /// Phase 2's bridge is worth building. Delete once the answers are recorded in
    /// docs/xbox-native-hdr-player/.
    ///
    /// Specifically it answers:
    ///
    ///   S1  Can a transparent WebView2 composite over this MediaPlayerElement? (This class
    ///       just supplies the element and the video; src/player/xbox-spike.js draws the
    ///       markers you actually judge it by.)
    ///   S2  Does AdaptiveMediaSource accept Plex's own start.m3u8? This is the load-bearing
    ///       question for the whole plan. The documented HLS tag support lists EXT-X-MAP as
    ///       unsupported, which rules out fMP4/CMAF segments and leaves MPEG-TS only - and
    ///       that table's last column is Windows 10 1607, so it is too stale to trust either
    ///       way. Hence ProbeAsync, which reports the exact creation status and the parse /
    ///       download diagnostics rather than a bare pass/fail.
    ///
    /// Not addressed here on purpose: HEVC and HDR. Plex currently transcodes everything to
    /// H.264 1080p SDR because of the client-capabilities string in core/stream-url.js, so
    /// this spike can only prove the SDR-parity path. HEVC-in-MPEG-TS ingestion is Phase 3's
    /// separate question, and needs the hevcPlayback capability plus that string widened
    /// before it can even be asked.
    /// </summary>
    internal sealed class NativePlayerSpike
    {
        private readonly Action<string> log;
        private readonly MediaPlayer player = new MediaPlayer();
        private AdaptiveMediaSource adaptiveSource;
        private string currentSessionId;
        private string lastProbedUrl;
        // AdaptiveMediaSource emits these per segment attempt, and against a cold transcode session
        // that is hundreds per second - 2,861 log lines in one run, which buried every other line.
        // The first few carry all the information; the rest is repetition.
        private int diagnosticBudget;
        private int tokenRewriteLogBudget;
        private const int DiagnosticBudgetPerAttempt = 8;
        // Refreshed on a timer rather than being a hard cap, so failures that continue AFTER
        // playback reports Playing stay visible. The previous hard cap was exhausted within 300ms
        // and hid whether segments kept failing during the 30s of nominal "Playing" that rendered
        // nothing.
        private DateTime diagnosticWindowStart = DateTime.MinValue;

        public MediaPlayerElement Element { get; }

        public bool IsPlaying { get; private set; }

        /// <summary>
        /// Distinguishes the two ways "Playing but nothing on screen" can happen: a position that
        /// does not advance means the pipeline is starved of segments, while a position that advances
        /// with no visible frames means a decode or presentation problem. Without this the previous
        /// run's 30 seconds of nominal Playing was unattributable.
        /// </summary>
        public double PositionSeconds => player.PlaybackSession.Position.TotalSeconds;

        public NativePlayerSpike(Action<string> log)
        {
            this.log = log ?? (_ => { });

            Element = new MediaPlayerElement
            {
                // The production configuration this spike is meant to validate, not a
                // convenience: leaving this element focusable would put a second focusable
                // XAML control in a tree that has only ever had one, which is exactly the
                // condition MainPage's gamepad comment says avoids the Xbox WebView2
                // XY-navigation focus trap (WebView2Feedback #4284). S4 is about confirming
                // that still holds.
                IsTabStop = false,
                // The WebView2 sits on top and owns all input; the video surface must never
                // intercept a pointer/click that the page expects to receive.
                IsHitTestVisible = false,
                AreTransportControlsEnabled = false,
                Stretch = Windows.UI.Xaml.Media.Stretch.Uniform,
            };
            Element.SetMediaPlayer(player);

            // The web player may well still be playing the same title inside the WebView2 when
            // this starts, and two copies of the same audio is both unpleasant and actively
            // misleading when judging whether native playback started. Video is the only thing
            // S1/S2 need to see.
            player.IsMuted = true;

            player.MediaOpened += (s, e) =>
            {
                MediaPlaybackSession session = s.PlaybackSession;
                log($"MediaOpened: {session.NaturalVideoWidth}x{session.NaturalVideoHeight}, " +
                    $"duration {session.NaturalDuration.TotalSeconds:F1}s");
            };
            // Where an unsupported container/codec combination surfaces - an HEVC-in-TS or
            // EXT-X-MAP problem shows up here as an MF_E_UNSUPPORTED_* error, after
            // AdaptiveMediaSource creation has already reported Success.
            player.MediaFailed += (s, e) =>
                log($"MediaFailed: {e.Error} / 0x{e.ExtendedErrorCode?.HResult:X8} / {e.ErrorMessage}");
            player.PlaybackSession.PlaybackStateChanged += (s, e) => log($"PlaybackState: {s.PlaybackState}");
        }

        /// <summary>
        /// S2. Reports the creation status in full rather than a boolean, because the failure
        /// modes are the informative part: ManifestParseFailure and UnsupportedManifestProfile
        /// mean something very different from ManifestDownloadFailure (which would just be a
        /// token or connectivity problem, not a format one).
        /// </summary>
        public async Task<bool> ProbeAsync(string url)
        {
            // Never leave a previous probe's transcode running.
            await StopPlexSessionAsync();
            diagnosticBudget = DiagnosticBudgetPerAttempt;
            diagnosticWindowStart = DateTime.UtcNow;
            tokenRewriteLogBudget = 3;

            // Native gets its own transcode session rather than reusing the one the web player is
            // still streaming on - a real native player has to own its session anyway, since Plex
            // session state is per-session (hence reloadWebSource's whole
            // stop-then-decide-then-start dance).
            //
            // But note the cost this exposed: a fresh session at a non-zero offset makes Plex start
            // transcoding from scratch at that point, and AdaptiveMediaSource prefetches far faster
            // than the server produces segments, so hundreds of segment requests 404
            // (0x80190194) and get skipped. The earlier run that reached MediaOpened + Playing was
            // reusing the web player's ALREADY-WARMED session, which is why it had segments to
            // serve. This is a real property of Plex's transcode-on-demand HLS versus AMS's
            // prefetch behaviour, not a transient - and it is the thing Phase 2 has to solve.
            url = WithFreshSession(url);
            lastProbedUrl = url;

            // Plex's Media Decision Engine does not re-evaluate a request without an explicit
            // /decision call carrying the SAME params as the /start that follows - established
            // empirically against a real server and documented at length in core/stream-url.js and
            // web-fallback.js's reloadWebSource. The native path skipped it entirely, which is a
            // plausible contributor to the transcoder not being ready when segments were requested.
            await AskDecisionAsync(url);

            // Run before AdaptiveMediaSource so its failure mode is distinguishable. A raw GET
            // that throws (E_ACCESSDENIED) means the app container blocked the request - a missing
            // network capability. A GET that returns a status means the request left the box and
            // Plex answered, so a 401/403 is a token or session problem instead. Those two look
            // identical through AdaptiveMediaSourceCreationStatus alone.
            string manifest = await FetchManifestAsync(url);
            currentSessionId = SessionIdOf(url);

            // Wait for the transcoder to actually produce segment 0 before handing the URL to
            // AdaptiveMediaSource. Without this it took 18.5s from button press to first frame: AMS
            // requests 00000.ts onwards immediately, Plex answers 200 with an empty/partial body
            // while ffmpeg is still spinning up, AMS reports ResourceParsingError (0x80070057) and
            // retries, and only recovers once real segments exist. Polling one segment ourselves
            // costs nothing and turns a 18s cold start into a measured wait.
            await WaitForFirstSegmentAsync(url, manifest);

            log($"Probing AdaptiveMediaSource: {Redact(url)}");
            AdaptiveMediaSourceCreationResult result;
            try
            {
                result = await AdaptiveMediaSource.CreateFromUriAsync(new Uri(url));
            }
            catch (Exception ex)
            {
                log($"Probe threw: {ex.GetType().Name} / {ex.Message}");
                return false;
            }

            if (result.Status != AdaptiveMediaSourceCreationStatus.Success)
            {
                log($"Probe FAILED: {result.Status} / 0x{result.ExtendedError?.HResult:X8}");
                return false;
            }

            AdaptiveMediaSource ams = result.MediaSource;
            // Plex serves one fixed-bitrate rendition per request rather than a multi-variant
            // manifest (see core/stream-url.js), so a single bitrate here is expected and
            // correct - it is not evidence of a truncated parse.
            log($"Probe OK: live={ams.IsLive}, bitrates=[{string.Join(",", ams.AvailableBitrates)}]");
            // Fired for manifest-parse and resource errors that don't fail creation outright -
            // the channel most likely to name an unsupported HLS tag.
            // Plex's media playlist lists segments as bare filenames, so the URIs AMS derives carry
            // no X-Plex-Token and Plex answers them with a 188-byte error document instead of media.
            // DownloadRequested is the documented hook for exactly this - rewriting the request URI
            // before AMS issues it - so every segment/playlist fetch gets the token put back.
            ams.DownloadRequested += (s, e) =>
            {
                Uri original = e.ResourceUri;
                if (original == null) return;
                string withToken = WithToken(original.ToString());
                if (withToken != original.ToString())
                {
                    e.Result.ResourceUri = new Uri(withToken);
                    if (tokenRewriteLogBudget-- > 0) log($"token-added {SegmentTail(original)}");
                }
            };

            // Budgeted, and now logging the actual ResourceUri - which is the datum that was missing
            // last run. 0x80190194 is HTTP 404, so knowing exactly which segment URI AMS asked for
            // distinguishes "the transcoder hasn't produced it yet" from "AMS built the wrong URL".
            ams.Diagnostics.DiagnosticAvailable += (s, e) =>
            {
                if (!AllowDiagnostic()) return;
                log($"AMS {e.DiagnosticType} {e.ResourceType} 0x{e.ExtendedError?.HResult:X8} {SegmentTail(e.ResourceUri)}");
            };
            ams.DownloadFailed += (s, e) =>
            {
                if (!AllowDiagnostic()) return;
                log($"AMS dl-fail {e.ResourceType} 0x{e.ExtendedError?.HResult:X8} {SegmentTail(e.ResourceUri)}");
            };
            adaptiveSource = ams;
            return true;
        }

        /// <summary>
        /// Probes, then plays through the same AdaptiveMediaSource instance so the diagnostics
        /// handlers registered during the probe stay attached for playback.
        /// </summary>
        public async Task PlayAsync(string url)
        {
            if (!await ProbeAsync(url)) return;
            player.Source = MediaSource.CreateFromAdaptiveMediaSource(adaptiveSource);
            player.Play();
            IsPlaying = true;
            log("Native playback started");
        }

        /// <summary>
        /// The alternative stack: Plex's progressive-MP4 output (protocol=http, start.mp4) played
        /// through a plain MediaSource, with no playlist, no segments and no transcoder-liveness
        /// dance. Worth testing directly rather than continuing to debug HLS, because every failure
        /// so far has been in that machinery rather than in decode: Plex serves empty single-packet
        /// TS segments regardless of token, and AdaptiveMediaSource additionally mis-seeks on Plex's
        /// #EXT-X-START:TIME-OFFSET (treating an absolute media position as an offset into a
        /// playlist that already starts there).
        ///
        /// If this plays, it is the better Phase 2 foundation anyway - MediaFoundation handles
        /// progressive MP4 over HTTP with byte-range seeking natively - and HLS becomes the fallback
        /// rather than the primary path.
        /// </summary>
        public async Task PlayProgressiveAsync(string url)
        {
            await StopPlexSessionAsync();
            string progressive = WithFreshSession(url)
                .Replace("/universal/start.m3u8", "/universal/start.mp4")
                .Replace("protocol=hls", "protocol=http");
            lastProbedUrl = progressive;
            currentSessionId = SessionIdOf(progressive);

            await AskDecisionAsync(progressive.Replace("/universal/start.mp4", "/universal/start.m3u8"));
            log($"progressive: {Truncate(Redact(progressive), 150)}");

            try
            {
                using (var http = new Windows.Web.Http.HttpClient())
                using (Windows.Web.Http.HttpResponseMessage response = await http.GetAsync(
                    new Uri(progressive), Windows.Web.Http.HttpCompletionOption.ResponseHeadersRead))
                {
                    log($"progressive GET -> {(int)response.StatusCode}, type={response.Content.Headers.ContentType}");
                }
            }
            catch (Exception ex)
            {
                log($"progressive GET threw 0x{ex.HResult:X8}");
            }

            player.Source = MediaSource.CreateFromUri(new Uri(progressive));
            player.Play();
            IsPlaying = true;
            log("Progressive playback started");
        }

        public void Stop()
        {
            player.Pause();
            player.Source = null;
            adaptiveSource = null;
            IsPlaying = false;
            log("Native playback stopped");
            // Fire-and-forget: the server needs telling, but nothing here should wait on it.
            _ = StopPlexSessionAsync();
        }

        // The full path, not just the filename. Logging only "00000.ts" hid the question that
        // actually matters: whether AMS resolved the segment against the MEDIA playlist's base
        // (correct) or the master playlist's (wrong, and it would request a path that doesn't
        // exist). The query is dropped because that is where the token lives.
        private static string SegmentTail(Uri uri)
        {
            return uri == null ? "(no uri)" : Truncate(uri.AbsolutePath, 90);
        }

        // Same URL, same params, only the endpoint swapped - plain substring replacement, because
        // a path-segment builder re-encodes the literal ':' in /video/:/transcode/universal/ to
        // %3A and silently 404s (the Android Uri.Builder.path() gotcha).
        private async Task AskDecisionAsync(string startUrl)
        {
            string decisionUrl = startUrl.Replace("/universal/start.m3u8", "/universal/decision");
            if (decisionUrl == startUrl)
            {
                log("decision: could not derive URL, skipping");
                return;
            }
            try
            {
                using (var http = new Windows.Web.Http.HttpClient())
                using (Windows.Web.Http.HttpResponseMessage response = await http.GetAsync(new Uri(decisionUrl)))
                {
                    log($"decision -> {(int)response.StatusCode}");
                }
            }
            catch (Exception ex)
            {
                // Best-effort, exactly as the JS leg treats it: a failed decision call should not
                // block the /start attempt that follows.
                log($"decision threw: 0x{ex.HResult:X8}");
            }
        }

        /// <summary>
        /// Tells Plex to tear down the transcode session this spike started. Without this, every
        /// probe leaves an ffmpeg process running on the server - which is what starved the web
        /// player's own session and failed it with fragLoadError.
        /// </summary>
        private async Task StopPlexSessionAsync()
        {
            if (string.IsNullOrEmpty(currentSessionId) || string.IsNullOrEmpty(lastProbedUrl)) return;
            string stopUrl = lastProbedUrl.Replace("/universal/start.m3u8", "/universal/stop");
            try
            {
                using (var http = new Windows.Web.Http.HttpClient())
                using (await http.GetAsync(new Uri(stopUrl))) { }
                log($"stopped Plex session {currentSessionId.Substring(0, 8)}");
            }
            catch (Exception ex)
            {
                log($"session stop threw: 0x{ex.HResult:X8}");
            }
            currentSessionId = null;
        }

        private static string SessionIdOf(string url)
        {
            int at = url.IndexOf("session=", StringComparison.OrdinalIgnoreCase);
            if (at < 0) return null;
            int start = at + "session=".Length;
            int end = url.IndexOf('&', start);
            return end < 0 ? url.Substring(start) : url.Substring(start, end - start);
        }

        private async Task<string> FetchManifestAsync(string url)
        {
            try
            {
                using (var http = new Windows.Web.Http.HttpClient())
                using (Windows.Web.Http.HttpResponseMessage response = await http.GetAsync(new Uri(url)))
                {
                    string body = await response.Content.ReadAsStringAsync();
                    log($"raw GET -> {(int)response.StatusCode} {response.StatusCode}, {body.Length}B");
                    // Logged verbatim (token masked). 159 bytes told us this is a MASTER playlist,
                    // not a media playlist - which is why the original "first segment" check was
                    // really fetching the variant playlist and passing spuriously. The structure
                    // matters for working out how AMS resolves segment URIs.
                    log($"manifest: {Truncate(Redact(body).Replace("\n", " | "), 220)}");
                    return response.IsSuccessStatusCode ? body : null;
                }
            }
            catch (Exception ex)
            {
                // 0x80070005 (E_ACCESSDENIED) here means the app container refused to let the
                // request out, i.e. a missing network capability rather than anything Plex did.
                log($"raw GET threw: 0x{ex.HResult:X8} / {ex.Message}");
                return null;
            }
        }

        // A transcode segment that exists is tens to hundreds of KB; the empty/partial bodies Plex
        // returns while warming up are far smaller. Deliberately generous - the point is only to
        // tell "nothing there yet" from "a real segment".
        private const int MinPlausibleSegmentBytes = 4096;
        private const int WarmupAttempts = 40;
        private const int WarmupDelayMs = 500;

        private async Task WaitForFirstSegmentAsync(string manifestUrl, string manifest)
        {
            // Descend from the master playlist to the media playlist before looking for a segment.
            // Without this the "first URI" is the variant playlist, and fetching that succeeds
            // immediately regardless of whether any segment exists - the check passed while telling
            // us nothing.
            string firstUri = FirstUriIn(manifestUrl, manifest);
            if (firstUri != null && firstUri.Contains(".m3u8"))
            {
                log($"manifest is a master playlist; descending to {Truncate(new Uri(firstUri).AbsolutePath, 70)}");
                string media = await FetchManifestAsync(firstUri);
                manifestUrl = firstUri;
                manifest = media;
            }

            string segmentUrl = FirstUriIn(manifestUrl, manifest);
            if (segmentUrl == null)
            {
                log("warmup: no segment URI in manifest, skipping wait");
                return;
            }
            // The full path AMS will be resolving against, so a base-URL mismatch is visible.
            log($"first segment: {Truncate(new Uri(segmentUrl).AbsolutePath, 90)}");

            // The decisive comparison. The segment URIs in Plex's media playlist are bare
            // ("00000.ts"), so once resolved they carry no X-Plex-Token - and Plex answered 200 with
            // a constant 188-byte body for 20 seconds straight, which is an error document, not a
            // segment that isn't ready. Fetching the same URL with the token appended settles
            // whether authorisation is the reason.
            await CompareTokenedFetchAsync(segmentUrl);

            for (int attempt = 1; attempt <= WarmupAttempts; attempt++)
            {
                try
                {
                    using (var http = new Windows.Web.Http.HttpClient())
                    using (Windows.Web.Http.HttpResponseMessage response = await http.GetAsync(new Uri(WithToken(segmentUrl))))
                    {
                        Windows.Storage.Streams.IBuffer buffer = await response.Content.ReadAsBufferAsync();
                        if (response.IsSuccessStatusCode && buffer.Length >= MinPlausibleSegmentBytes)
                        {
                            log($"warmup: segment ready after {attempt} attempt(s), {buffer.Length}B");
                            return;
                        }
                        if (attempt == 1 || attempt % 8 == 0)
                        {
                            log($"warmup {attempt}: {(int)response.StatusCode}, {buffer.Length}B - waiting");
                        }
                    }
                }
                catch (Exception ex)
                {
                    if (attempt == 1) log($"warmup GET threw: 0x{ex.HResult:X8}");
                }
                await Task.Delay(WarmupDelayMs);
            }
            log($"warmup: gave up after {WarmupAttempts} attempts - starting anyway");
        }

        // Fetches the same segment with and without the token and logs both, including the small
        // body verbatim - a 188-byte response is an error document and will name its own cause.
        private async Task CompareTokenedFetchAsync(string segmentUrl)
        {
            await LogOneFetchAsync("no-token", segmentUrl);
            await LogOneFetchAsync("tokened ", WithToken(segmentUrl));
        }

        private async Task LogOneFetchAsync(string label, string url)
        {
            try
            {
                using (var http = new Windows.Web.Http.HttpClient())
                using (Windows.Web.Http.HttpResponseMessage response = await http.GetAsync(new Uri(url)))
                {
                    Windows.Storage.Streams.IBuffer buffer = await response.Content.ReadAsBufferAsync();
                    string detail = "";
                    if (buffer.Length > 0 && buffer.Length < 2048)
                    {
                        // Small enough to be an error document rather than media - print it.
                        string body = await response.Content.ReadAsStringAsync();
                        detail = " :: " + Truncate(Redact(body).Replace("\n", " ").Replace("\r", ""), 180);
                    }
                    log($"seg {label} -> {(int)response.StatusCode} {buffer.Length}B{detail}");
                }
            }
            catch (Exception ex)
            {
                log($"seg {label} threw 0x{ex.HResult:X8}");
            }
        }

        private string WithToken(string url)
        {
            if (url.IndexOf("X-Plex-Token=", StringComparison.OrdinalIgnoreCase) >= 0) return url;
            string token = ValueOf(lastProbedUrl, "X-Plex-Token");
            if (string.IsNullOrEmpty(token)) return url;
            return url + (url.Contains("?") ? "&" : "?") + "X-Plex-Token=" + token;
        }

        private static string ValueOf(string url, string key)
        {
            if (string.IsNullOrEmpty(url)) return null;
            int at = url.IndexOf(key + "=", StringComparison.OrdinalIgnoreCase);
            if (at < 0) return null;
            int start = at + key.Length + 1;
            int end = url.IndexOf('&', start);
            return end < 0 ? url.Substring(start) : url.Substring(start, end - start);
        }

        // First non-comment, non-blank line of the media playlist, resolved against the manifest's
        // own URL. Plex's start.m3u8 returns the media playlist directly (one fixed-bitrate
        // rendition, see core/stream-url.js), so there is no master playlist to descend through.
        private static string FirstUriIn(string manifestUrl, string manifest)
        {
            if (string.IsNullOrEmpty(manifest)) return null;
            foreach (string raw in manifest.Split('\n'))
            {
                string line = raw.Trim();
                if (line.Length == 0 || line[0] == '#') continue;
                try
                {
                    return new Uri(new Uri(manifestUrl), line).ToString();
                }
                catch (Exception)
                {
                    return null;
                }
            }
            return null;
        }

        // Plain string substitution, deliberately not a Uri/query-builder API: this URL contains
        // the literal ':' in /video/:/transcode/universal/, and Android's Uri.Builder.path()
        // re-encoded it to %3A and silently 404'd. Same footgun applies to .NET's builders.
        private static string WithFreshSession(string url)
        {
            int at = url.IndexOf("session=", StringComparison.OrdinalIgnoreCase);
            if (at < 0) return url;
            int end = url.IndexOf('&', at);
            string tail = end < 0 ? "" : url.Substring(end);
            return url.Substring(0, at) + "session=" + Guid.NewGuid().ToString() + tail;
        }

        // The transcode URL carries X-Plex-Token as a query param (Plex won't answer a
        // preflight for a header token - see the repo's CLAUDE.md), and this log is rendered
        // on screen on a TV, so the token gets masked rather than displayed.
        // A few lines every 5 seconds, indefinitely - enough to see that failures are ongoing
        // without the hundreds-per-second flood that buried an entire earlier run.
        private bool AllowDiagnostic()
        {
            DateTime now = DateTime.UtcNow;
            if ((now - diagnosticWindowStart).TotalSeconds >= 5)
            {
                diagnosticWindowStart = now;
                diagnosticBudget = DiagnosticBudgetPerAttempt;
            }
            return diagnosticBudget-- > 0;
        }

        private static string Truncate(string value, int max)
        {
            if (string.IsNullOrEmpty(value)) return "(empty)";
            return value.Length <= max ? value : value.Substring(0, max) + "...";
        }

        // Masks the value in place rather than truncating at the token, because this is now also used
        // on manifest bodies, where truncating would throw away everything after the first tokened
        // URI - which is the part worth reading.
        private static string Redact(string text)
        {
            if (string.IsNullOrEmpty(text)) return text;
            const string key = "X-Plex-Token=";
            var sb = new System.Text.StringBuilder();
            int at = 0;
            while (true)
            {
                int found = text.IndexOf(key, at, StringComparison.OrdinalIgnoreCase);
                if (found < 0)
                {
                    sb.Append(text, at, text.Length - at);
                    break;
                }
                sb.Append(text, at, found - at).Append(key).Append("***");
                at = found + key.Length;
                while (at < text.Length && text[at] != '&' && text[at] != '\n' && text[at] != '"') at++;
            }
            return sb.ToString();
        }
    }
}
