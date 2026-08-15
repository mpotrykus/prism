using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;
using PrismXbox.Player;
using System;
using System.Collections.Generic;
using System.Diagnostics;
// Windows.Data.Json, not System.Text.Json: the latter isn't part of the UWP framework and
// pulls reflection-heavy dependencies that behave badly under the .NET Native toolchain
// Release builds use. The WinRT JSON API is always present and, usefully here, makes a value's
// type explicit (JsonValueType) - which is how a number arriving where a string was expected
// gets caught rather than silently becoming null, the exact failure that cost five rounds of
// debugging on the Android bridge.
using Windows.Data.Json;
using Windows.System;
using Windows.UI;
using Windows.UI.Core;
using Windows.UI.ViewManagement;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;
using Windows.UI.Xaml.Input;
using Windows.UI.Xaml.Media;

namespace PrismXbox
{
    /// <summary>
    /// Hosts the built Prism web app (bundled under www/, synced from the root repo's
    /// `npm run xbox:sync`) full-screen inside a WebView2 control.
    ///
    /// Currently also carries the Phase 0 native-player hardware spike (NativePlayerSpike +
    /// the SPIKE-marked members below), which is temporary: it answers, on a real console,
    /// whether MediaFoundation can be the native player before Phase 2's real bridge is worth
    /// building. Everything marked SPIKE comes out once the answers land in
    /// docs/xbox-native-hdr-player/.
    ///
    /// Layout is a Grid rather than the WebView2 alone so a video surface can sit behind the
    /// page: MediaPlayerElement at z=0, WebView2 (transparent) at z=1, diagnostics on top.
    /// </summary>
    public sealed partial class MainPage : Page
    {
        private WebView2 webView;

        // The real Phase 2 player and its bridge. Runs alongside the Phase 0 spike during bring-up:
        // the spike's Y/Menu triggers and on-screen log are still the only way to compare stacks on
        // hardware, and both it and the SPIKE-marked members below come out once native playback is
        // driven entirely by the app.
        private NativePlayerHost playerHost;
        private PlayerBridge playerBridge;

        // SPIKE
        private NativePlayerSpike nativeSpike;
        private TextBlock diagnostics;
        private Border diagnosticsPanel;
        private readonly List<string> diagnosticLines = new List<string>();
        private string lastStreamUrl;
        private DateTime lastHeartbeatAt = DateTime.MinValue;
        private const int MaxDiagnosticLines = 18;
        // Bumped on every spike iteration and logged at startup, so "did my build actually get
        // deployed?" is answerable by looking at the screen instead of inferring it.
        private const string SpikeBuild = "spike-10";
        private string lastLoggedMessage;
        private int repeatCount;
        // Logged once per newly-seen key rather than on every press: enough to prove which
        // VirtualKeys the console actually delivers to CoreWindow.KeyDown, without D-pad repeats
        // flooding the 18-line panel. This exists because X/Y appeared to do nothing on the first
        // spike build, and "our handler never ran" and "those keys never arrive" look identical
        // from the outside.
        private readonly HashSet<VirtualKey> keysSeen = new HashSet<VirtualKey>();
        // Second, independent route to the X/Y triggers. Xbox synthesizes keyboard equivalents
        // for D-pad/A/B (arrows/Enter/Escape), which is why the existing forwarding works, but
        // X and Y have no keyboard equivalent and may therefore never surface as a
        // CoreWindow.KeyDown at all - a plausible explanation for the first spike build appearing
        // to ignore them. Windows.Gaming.Input reads the pad directly and bypasses the question.
        // It has no event for button presses, hence the poll and the edge detection.
        private DispatcherTimer padPollTimer;
        private bool padXWasDown;
        private bool padYWasDown;
        private bool padMenuWasDown;
        // Set the first time X or Y arrives as a CoreWindow key event, which switches the polling
        // fallback off. Without this both routes would act on the same press - the double-handled
        // input trap this project already hit once on the moonlight-xbox side, and it would show up
        // here as Y appearing to do nothing because playback was started and immediately stopped.
        private bool padTriggersArriveAsKeys;
        private int padTickCount;

        // "prismxbox.local" is an arbitrary virtual hostname mapped below to the bundled "www"
        // folder via SetVirtualHostNameToFolderMapping. This is WebView2's recommended mechanism
        // for local content and is what Microsoft's own current Xbox WebView2 reference sample
        // (microsoft/Media-App-Samples-for-Xbox) uses - NOT the ms-appx-web:// scheme, which
        // belongs to the older, non-WebView2 UWP WebView control.
        private const string VirtualHostName = "prismxbox.local";
        private const string InitialUri = "https://prismxbox.local/index.html";

        public MainPage()
        {
            this.InitializeComponent();

            // On Xbox, this disables the automatic TV-safe-area border so the app can use the
            // full frame. See https://learn.microsoft.com/windows/apps/design/devices/designing-for-tv#tv-safe-area
            ApplicationView.GetForCurrentView().SetDesiredBoundsMode(ApplicationViewBoundsMode.UseCoreWindow);

            // CoreWindow.KeyDown fires window-wide regardless of which XAML control holds
            // logical focus, which sidesteps the open "WebView2 gamepad focus trap" risk
            // entirely for input *delivery* - see OnCoreWindowKeyDown below.
            Windows.UI.Xaml.Window.Current.CoreWindow.KeyDown += OnCoreWindowKeyDown;

            // The console stays in whatever display mode it was last put into, so leaving HDR on when
            // the app is suspended or closed leaves the dashboard rendering with inaccurate colour.
            // moonlight-xbox restores only on explicit disconnect and has exactly that bug when killed
            // mid-stream. Suspending covers the dashboard button and app close; EnteredBackground covers
            // being pushed behind something else.
            Windows.ApplicationModel.Core.CoreApplication.Suspending += (s, e) => RestoreDisplayMode();
            Windows.ApplicationModel.Core.CoreApplication.EnteredBackground += (s, e) => RestoreDisplayMode();

            InitializeWebViewAsync();
        }

        private async void InitializeWebViewAsync()
        {
            webView = new WebView2();

            // Match the app shell's background so the WebView2 control's own default draw
            // color doesn't flash before content loads.
            webView.Background = new SolidColorBrush(Color.FromArgb(255, 10, 10, 12));

            await webView.EnsureCoreWebView2Async();
            CoreWebView2 coreWebView = webView.CoreWebView2;

            // The WebView2 control must be added to the visual tree (and focused) only after
            // EnsureCoreWebView2Async() completes - it can't receive focus before that.
            this.Content = BuildLayout();
            webView.Focus(Windows.UI.Xaml.FocusState.Programmatic);

            if (coreWebView == null)
            {
                // TODO: show an error state. This should only happen if the WebView2 Runtime
                // couldn't be resolved/installed - worth checking for on real Xbox hardware as
                // part of the Phase 3 validation pass.
                Debug.WriteLine("Unable to retrieve CoreWebView2 - is the WebView2 Runtime available?");
                return;
            }

            coreWebView.Settings.AreDefaultContextMenusEnabled = false;
            coreWebView.Settings.IsStatusBarEnabled = false;
            coreWebView.Settings.IsGeneralAutofillEnabled = false;
            coreWebView.Settings.IsPasswordAutosaveEnabled = false;

            // Leave DevTools enabled for now - this shell only exists to validate on real
            // hardware. Disable before any Store submission (Phase 4).
            coreWebView.Settings.AreDevToolsEnabled = true;

            coreWebView.SetVirtualHostNameToFolderMapping(
                VirtualHostName, "www", CoreWebView2HostResourceAccessKind.Allow);

            coreWebView.ProcessFailed += OnWebViewProcessFailed;
            webView.NavigationCompleted += OnNavigationCompleted;

            // The real playback bridge. It subscribes WebMessageReceived itself and ignores anything
            // without a "method" field, so it coexists with the spike handler below on one channel.
            playerBridge = new PlayerBridge(coreWebView, playerHost, Log);

            // SPIKE: the diagnostic harness's own half of the channel (messages carrying "type"). Comes
            // out with the rest of the spike.
            coreWebView.WebMessageReceived += OnWebMessageReceived;

            // SPIKE. Two jobs, both about making a silent JS-side failure visible on the TV:
            //
            //  1. Post one message from injected script before any app module evaluates. That
            //     bisects "the WebView2 message channel is broken" from "the app's own JS never
            //     got as far as calling initXboxSpike()" - which look identical from the outside,
            //     and the second is exactly what a stale service-worker-cached bundle or a module
            //     throwing during import would produce.
            //  2. Forward window.onerror, unhandled rejections, and console.error/warn to the
            //     native log, so a JS exception is readable on screen. There is no other way to
            //     see it: the console is only reachable over remote DevTools, which needs
            //     --remote-debugging-address to be reachable off-console and isn't set.
            //
            // Must be awaited before navigation, or the document it should run in has already
            // been created.
            await coreWebView.AddScriptToExecuteOnDocumentCreatedAsync(@"
                (function () {
                  // Tells src/player/core/platform.js this is the Xbox shell, before any app module
                  // evaluates. platformTag() then reports 'xbox', which routes playback to
                  // xbox-bridge.js and makes Plex serve progressive output instead of HLS.
                  window.__prismXboxNativePlayer = true;
                  var wv = window.chrome && window.chrome.webview;
                  if (!wv) return;
                  var send = function (type, message) {
                    // Stringified, matching xbox-spike.js - see its post() for why an object
                    // payload never arrived on this runtime.
                    try { wv.postMessage(JSON.stringify({ type: type, message: String(message) })); } catch (e) {}
                  };
                  send('spikeInjected', navigator.userAgent);
                  window.addEventListener('error', function (e) {
                    send('spikeJsError', (e && e.message) + ' @ ' + (e && e.filename) + ':' + (e && e.lineno));
                  });
                  window.addEventListener('unhandledrejection', function (e) {
                    send('spikeJsError', 'unhandled rejection: ' + (e && e.reason));
                  });
                  ['error', 'warn'].forEach(function (level) {
                    var original = console[level];
                    console[level] = function () {
                      send('spikeJsConsole', level + ': ' + Array.prototype.join.call(arguments, ' '));
                      original.apply(console, arguments);
                    };
                  });
                })();
            ");

            // SPIKE. The WebView2 profile persists across deployments, and the app registers a
            // service worker (sw.js). A stale cached bundle would look exactly like the symptom
            // seen on the previous run - app works, native input works, but no JS message ever
            // arrives - because the cached bundle predates the spike code. sw.js is network-first
            // so this shouldn't happen, but it costs one call to stop wondering.
            //
            // CacheStorage and DiskCache ONLY. Not AllDomStorage/IndexedDb/LocalStorage: those
            // hold the Plex token (vault.js) and all settings, so clearing them would sign the
            // user out on every launch.
            try
            {
                await coreWebView.Profile.ClearBrowsingDataAsync(
                    CoreWebView2BrowsingDataKinds.CacheStorage | CoreWebView2BrowsingDataKinds.DiskCache);
                Log("cleared HTTP + CacheStorage caches (token/settings untouched)");
            }
            catch (Exception ex)
            {
                Log($"cache clear unavailable: {ex.GetType().Name}");
            }

            webView.Source = new Uri(InitialUri);
        }

        // SPIKE. MediaPlayerElement first so it renders behind the WebView2; the diagnostics
        // TextBlock last so it stays readable over both. Neither added control is focusable
        // (MediaPlayerElement has IsTabStop=false, a TextBlock never is), which is what keeps
        // webView the only focusable control in the tree - the invariant OnCoreWindowKeyDown's
        // comment below depends on, and what S4 is checking.
        private Grid BuildLayout()
        {
            nativeSpike = new NativePlayerSpike(Log);

            diagnostics = new TextBlock
            {
                FontFamily = new FontFamily("Consolas"),
                FontSize = 18,
                Foreground = new SolidColorBrush(Colors.Lime),
            };

            // UWP's TextBlock is a FrameworkElement with no Background of its own (WinUI 3 added
            // one), so the backing plate has to be a Border - and it needs one: the log has to
            // stay legible against video, not against whatever the page happens to be painting.
            diagnosticsPanel = new Border
            {
                Child = diagnostics,
                Background = new SolidColorBrush(Color.FromArgb(190, 0, 0, 0)),
                Padding = new Thickness(10),
                HorizontalAlignment = HorizontalAlignment.Left,
                VerticalAlignment = VerticalAlignment.Top,
                IsHitTestVisible = false,
                // Visible from startup, not on first log line: the panel appearing at all is the
                // signal that this build is the one running on the console.
                Visibility = Visibility.Visible,
            };

            // The real player's surface goes in first (z=0, behind the WebView2). The spike's element
            // is added after it and stays hidden unless its own test is triggered, so only one video
            // surface is ever visible.
            // Marshalled to the UI thread, because MediaPlayer and MediaPlaybackSession raise their
            // events on background threads while CoreWebView2.PostWebMessageAsJson may only be called
            // on the UI thread. Without this every emit fails with 0x802A000C and JS receives nothing -
            // native playback runs perfectly and the page never hears about it. Log() already did this,
            // which is exactly why the log stayed readable while the bridge appeared silent.
            playerHost = new NativePlayerHost(
                (name, json) => _ = Dispatcher.RunAsync(
                    CoreDispatcherPriority.Normal, () => playerBridge?.Emit(name, json)),
                Log);

            var grid = new Grid();
            grid.Children.Add(playerHost.Element);
            grid.Children.Add(nativeSpike.Element);
            grid.Children.Add(webView);
            grid.Children.Add(diagnosticsPanel);

            Log($"{SpikeBuild} loaded. Press any button - every new key is logged below.");
            Log("Y = HLS test, Menu = progressive-MP4 test, X = hide this panel.");
            StartPadPolling();
            return grid;
        }

        // SPIKE. Keeps a long payload (a tokened Plex URL is ~600 chars) from blowing the panel.
        private static string Truncate(string value, int max)
        {
            if (string.IsNullOrEmpty(value)) return "(empty)";
            return value.Length <= max ? value : value.Substring(0, max) + "...";
        }

        private void RestoreDisplayMode()
        {
            // Deliberately not awaited: a Suspending handler without a deferral has no guarantee of
            // outliving the await, and the display-mode change is a system-level call that completes on
            // its own. Nothing here depends on the result.
            _ = playerHost?.RestoreDisplayAsync();
        }

        // SPIKE. Rendered on screen rather than to Debug output because the point is to read
        // results on a TV without depending on remote DevTools reaching the console.
        private void Log(string line)
        {
            Debug.WriteLine($"[spike] {line}");
            _ = Dispatcher.RunAsync(CoreDispatcherPriority.Low, () =>
            {
                // Coalesce consecutive identical messages into "(xN)" rather than appending each.
                // Not cosmetic: pressing Y repeatedly logged the same line over and over and
                // pushed the startup lines - the ones that say whether the JS side ever reported
                // in - straight out of the 18-line window, which is how the most useful
                // information got lost on the previous run.
                if (lastLoggedMessage == line && diagnosticLines.Count > 0)
                {
                    repeatCount++;
                    diagnosticLines[diagnosticLines.Count - 1] = $"{DateTime.Now:HH:mm:ss} {line} (x{repeatCount})";
                }
                else
                {
                    lastLoggedMessage = line;
                    repeatCount = 1;
                    diagnosticLines.Add($"{DateTime.Now:HH:mm:ss} {line}");
                }
                if (diagnosticLines.Count > MaxDiagnosticLines)
                {
                    diagnosticLines.RemoveRange(0, diagnosticLines.Count - MaxDiagnosticLines);
                }
                if (diagnostics != null)
                {
                    diagnostics.Text = string.Join("\n", diagnosticLines);
                }
            });
        }

        // SPIKE
        private void OnWebMessageReceived(CoreWebView2 sender, CoreWebView2WebMessageReceivedEventArgs args)
        {
            // Everything below is wrapped because an exception thrown out of a WinRT event handler
            // is swallowed at the ABI boundary - the handler would appear never to have run, which
            // is indistinguishable from the message never arriving. That ambiguity was one of the
            // two candidate causes for the outbound channel appearing dead in spike-3.
            try
            {
                DispatchWebMessage(args);
            }
            catch (Exception ex)
            {
                Log($"web message handler threw: {ex.GetType().Name} / {ex.Message}");
            }
        }

        // SPIKE
        private void DispatchWebMessage(CoreWebView2WebMessageReceivedEventArgs args)
        {
            // Accept either envelope. JS now posts a JSON string (WebMessageAsJson would then be
            // that string, JSON-quoted, and TryGetWebMessageAsString gives it unwrapped), but an
            // object post is still handled so this doesn't depend on which form works.
            string payload;
            try
            {
                payload = args.TryGetWebMessageAsString();
            }
            catch (Exception)
            {
                payload = args.WebMessageAsJson;
            }

            // Logged before parsing: if the handler is running at all, this proves it, and shows
            // exactly what shape arrived.
            Log($"msg<- {Truncate(payload, 90)}");

            if (!JsonObject.TryParse(payload, out JsonObject root))
            {
                Log("Bad web message: not a JSON object");
                return;
            }

            // "" not null as the default: a WinRT HSTRING cannot be null, so GetNamedString throws
            // ArgumentNullException on a null default rather than returning it. That threw on every
            // single message in spike-4 - each one arrived, got logged, and was then discarded by
            // the exception - which looked exactly like the channel still being broken.
            // Messages carrying "method" belong to PlayerBridge, which shares this channel. Ignored
            // silently rather than logged, so the real bridge's traffic doesn't read as spike errors.
            if (root.ContainsKey("method")) return;

            string type = root.GetNamedString("type", "");
            switch (type)
            {
                case "spikeInjected":
                    // Proves the message channel works and injected script ran. If this appears
                    // but spikeReady never does, the app's own bundle is the problem, not the
                    // bridge.
                    Log("injected script ran - message channel OK");
                    break;
                case "spikeJsError":
                    Log($"JS ERROR: {root.GetNamedString("message", "(none)")}");
                    break;
                case "spikeJsConsole":
                    Log($"JS {root.GetNamedString("message", "(none)")}");
                    break;
                case "spikeReady":
                    Log("JS harness ready. Y = play/stop native, X = toggle diagnostics.");
                    break;
                case "spikeStreamUrl":
                    lastStreamUrl = root.GetNamedString("url", "");
                    if (string.IsNullOrEmpty(lastStreamUrl))
                    {
                        Log("spikeStreamUrl arrived with no usable url");
                        break;
                    }
                    // Deliberately does NOT auto-probe any more. "Probing does not start playback"
                    // was wrong: requesting start.m3u8 makes Plex spin up a real ffmpeg transcode
                    // session, and doing that on every URL message left three orphaned sessions
                    // running on the server, which starved the web player's own session badly
                    // enough to fail it with fragLoadError. Probing is Y-only now, and the session
                    // gets stopped afterwards.
                    Log("Stream URL received. Press Y to probe + play natively.");
                    break;
                case "spikeHeartbeat":
                    OnHeartbeat(root);
                    break;
                default:
                    Log($"Unhandled web message type: {(type.Length == 0 ? "(none)" : type)}");
                    break;
            }
        }

        // SPIKE, S3. What matters is the GAP between heartbeats, not the count: if WebView2
        // suspends JS the way Android's WebView did, ticks simply stop arriving while native
        // video is foregrounded, and the gap on the last line before the stall is the evidence.
        // fetchOk being false while ticks keep arriving would be the subtler failure - timers
        // alive but network loading suspended, which is what actually bit the Android leg.
        private void OnHeartbeat(JsonObject root)
        {
            DateTime now = DateTime.Now;
            double gapMs = lastHeartbeatAt == DateTime.MinValue ? 0 : (now - lastHeartbeatAt).TotalMilliseconds;
            lastHeartbeatAt = now;

            int tick = (int)root.GetNamedNumber("tick", -1);
            string fetchOk = IsNull(root, "fetchOk") ? "n/a" : root.GetNamedBoolean("fetchOk", false).ToString();
            string fetchMs = IsNull(root, "fetchMs") ? "n/a" : $"{(int)root.GetNamedNumber("fetchMs", 0)}ms";
            Log($"heartbeat #{tick} gap={gapMs:F0}ms fetch={fetchOk} in {fetchMs}");
        }

        // SPIKE. JS sends null for these until it has an origin to probe, and GetNamedBoolean
        // would throw on a null-valued key rather than returning its default.
        private static bool IsNull(JsonObject obj, string key)
        {
            return !obj.ContainsKey(key) || obj[key].ValueType == JsonValueType.Null;
        }

        // SPIKE
        private void StartPadPolling()
        {
            padPollTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(100) };
            padPollTimer.Tick += (s, e) =>
            {
                if (padTriggersArriveAsKeys) return;
                var pads = Windows.Gaming.Input.Gamepad.Gamepads;
                if (pads.Count == 0) return;
                Windows.Gaming.Input.GamepadReading reading = pads[0].GetCurrentReading();
                bool xDown = (reading.Buttons & Windows.Gaming.Input.GamepadButtons.X) != 0;
                bool yDown = (reading.Buttons & Windows.Gaming.Input.GamepadButtons.Y) != 0;
                bool menuDown = (reading.Buttons & Windows.Gaming.Input.GamepadButtons.Menu) != 0;

                // Menu = the progressive-MP4 path, so both stacks can be compared in one run
                // without redeploying.
                if (menuDown && !padMenuWasDown)
                {
                    Log("Menu -> progressive MP4 test");
                    StartProgressive();
                }
                padMenuWasDown = menuDown;

                // Edge-triggered: a held button would otherwise fire every 100ms.
                if (yDown && !padYWasDown)
                {
                    Log("Y (via Windows.Gaming.Input)");
                    ToggleNativePlayback();
                }
                if (xDown && !padXWasDown && diagnosticsPanel != null)
                {
                    diagnosticsPanel.Visibility = diagnosticsPanel.Visibility == Visibility.Visible
                        ? Visibility.Collapsed
                        : Visibility.Visible;
                }
                padXWasDown = xDown;
                padYWasDown = yDown;

                // SPIKE, S3 via the proven channel. Pulling the heartbeat rather than waiting to
                // be told it means S3 is answerable even with the outbound postMessage channel
                // dead - and the pull is itself diagnostic: if JS is suspended while native video
                // is foregrounded, ExecuteScriptAsync will stall or return a tick whose timestamp
                // stops advancing. Every 10th 100ms tick, so once a second, and only while
                // playing.
                if (nativeSpike?.IsPlaying == true && ++padTickCount % 10 == 0)
                {
                    // Position alongside the heartbeat: a frozen position means the decoder is
                    // starved, an advancing one with a blank screen means a presentation problem.
                    Log($"pos={nativeSpike.PositionSeconds:F1}s");
                    _ = PullHeartbeatAsync();
                }
            };
            padPollTimer.Start();
        }

        // SPIKE
        private async System.Threading.Tasks.Task<string> PullStreamUrlAsync()
        {
            try
            {
                // ExecuteScriptAsync returns the result JSON-encoded, so a string comes back
                // quoted and has to be unwrapped before use.
                string raw = await webView.CoreWebView2.ExecuteScriptAsync(
                    "window.__prismSpikeStreamUrl || ''");
                if (string.IsNullOrEmpty(raw) || raw == "null") return null;
                JsonValue value = JsonValue.Parse(raw);
                string url = value.ValueType == JsonValueType.String ? value.GetString() : null;
                return string.IsNullOrEmpty(url) ? null : url;
            }
            catch (Exception ex)
            {
                Log($"URL pull failed: {ex.GetType().Name} / {ex.Message}");
                return null;
            }
        }

        // SPIKE, S3
        private async System.Threading.Tasks.Task PullHeartbeatAsync()
        {
            try
            {
                string raw = await webView.CoreWebView2.ExecuteScriptAsync(
                    "window.__prismSpikeHeartbeat || ''");
                if (string.IsNullOrEmpty(raw) || raw == "null") return;
                JsonValue outer = JsonValue.Parse(raw);
                if (outer.ValueType != JsonValueType.String) return;
                string inner = outer.GetString();
                if (string.IsNullOrEmpty(inner) || !JsonObject.TryParse(inner, out JsonObject hb)) return;

                int tick = (int)hb.GetNamedNumber("tick", -1);
                // JS Date.now() is ms since epoch; compare against the same clock rather than the
                // console's local time, so the age is real and not a timezone artefact.
                double at = hb.GetNamedNumber("at", 0);
                double ageMs = (DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc))
                    .TotalMilliseconds - at;
                string fetchOk = IsNull(hb, "fetchOk") ? "n/a" : hb.GetNamedBoolean("fetchOk", false).ToString();
                Log($"hb(pull) #{tick} age={ageMs:F0}ms fetch={fetchOk}");
            }
            catch (Exception ex)
            {
                // A stall or throw here is itself the S3 answer: JS isn't running.
                Log($"hb pull failed: {ex.GetType().Name}");
            }
        }

        // SPIKE, S2
        private async System.Threading.Tasks.Task ProbeReceivedUrlAsync()
        {
            if (nativeSpike == null || string.IsNullOrEmpty(lastStreamUrl)) return;
            try
            {
                await nativeSpike.ProbeAsync(lastStreamUrl);
            }
            catch (Exception ex)
            {
                Log($"Auto-probe threw: {ex.GetType().Name} / {ex.Message}");
            }
        }

        // SPIKE
        private void PostToJs(string type)
        {
            var message = new JsonObject { ["type"] = JsonValue.CreateStringValue(type) };
            webView?.CoreWebView2?.PostWebMessageAsJson(message.Stringify());
        }

        // SPIKE
        private async void StartProgressive()
        {
            if (nativeSpike == null) return;
            if (nativeSpike.IsPlaying) nativeSpike.Stop();
            if (string.IsNullOrEmpty(lastStreamUrl))
            {
                lastStreamUrl = await PullStreamUrlAsync();
                if (string.IsNullOrEmpty(lastStreamUrl))
                {
                    Log("No URL yet - play a title in the app first.");
                    return;
                }
            }
            PostToJs("spikePlaybackStarted");
            await nativeSpike.PlayProgressiveAsync(lastStreamUrl);
        }

        // SPIKE
        private async void ToggleNativePlayback()
        {
            if (nativeSpike == null) return;
            if (nativeSpike.IsPlaying)
            {
                nativeSpike.Stop();
                PostToJs("spikePlaybackStopped");
                lastHeartbeatAt = DateTime.MinValue;
                return;
            }
            if (string.IsNullOrEmpty(lastStreamUrl))
            {
                // Fall back to pulling it out of the page rather than waiting to be told. See
                // xbox-spike.js's reportStreamUrl: ExecuteScriptAsync is the channel already
                // proven to work on this shell, so this keeps S2 answerable even if postMessage
                // is the broken half.
                Log("No pushed URL - pulling from page via ExecuteScriptAsync...");
                lastStreamUrl = await PullStreamUrlAsync();
                if (string.IsNullOrEmpty(lastStreamUrl))
                {
                    Log("Still no URL. Start playback in the app once, then press Y.");
                    return;
                }
                Log("Pulled URL from page OK - postMessage is the broken half.");
            }
            // Told before playback starts so the page is already transparent with its markers
            // drawn when the first video frame lands - otherwise S1 can't distinguish "video
            // never appeared" from "the page hadn't gone transparent yet".
            PostToJs("spikePlaybackStarted");
            await nativeSpike.PlayAsync(lastStreamUrl);
        }

        private void OnNavigationCompleted(WebView2 sender, CoreWebView2NavigationCompletedEventArgs args)
        {
            if (!args.IsSuccess)
            {
                Debug.WriteLine($"Initial WebView2 navigation failed: {args.WebErrorStatus}");
            }
        }

        private void OnWebViewProcessFailed(CoreWebView2 sender, CoreWebView2ProcessFailedEventArgs args)
        {
            Debug.WriteLine($"WebView2 process failed: {args.ProcessFailedKind} / {args.Reason}");
        }

        // WebView2 is a separate Chromium process hosted as a visual island, not the old
        // UWP Windows.UI.Xaml.Controls.WebView - it does not automatically receive Xbox
        // gamepad D-pad/A/B presses as page-level KeyboardEvents or Gamepad API state the
        // way Fire TV's Silk browser apparently does with its own remote. Confirmed on this
        // machine's other Xbox UWP project (moonlight-xbox, unrelated stack) that these
        // GamepadDPad*/A/B VirtualKeys DO arrive via CoreWindow.KeyDown on real Xbox
        // hardware - they just never reached the WebView2 DOM. Forwarding them here as
        // synthetic KeyboardEvents feeds the exact same pathway focus-nav.js already wires
        // real keyboard input through, so nothing on the web-app side needs to change.
        //
        // Unlike moonlight-xbox's ListView, there is exactly one focusable XAML control in
        // this whole app (webView) - there's nothing for XAML's native XY focus navigation
        // to move focus to/away from, so there's no double-handling risk here the way there
        // was for moonlight-xbox's DPad-vs-XY-nav case (see that project's memory).
        private void OnCoreWindowKeyDown(CoreWindow sender, KeyEventArgs args)
        {
            // SPIKE: log each distinct key once. If a button press produces a line here, this
            // handler is running and the build is current; if a specific button never appears,
            // the console isn't delivering that VirtualKey to CoreWindow.KeyDown at all. Those
            // two causes are indistinguishable without this.
            if (keysSeen.Add(args.VirtualKey))
            {
                Log($"key seen: {args.VirtualKey} ({(int)args.VirtualKey})");
            }

            // SPIKE: X and Y are unmapped below, so they fall through to the page today and
            // are free to drive the harness without colliding with anything the app uses.
            // RightShoulder is accepted as a second play/stop trigger purely as a fallback in
            // case X/Y turn out not to be delivered here.
            if (args.VirtualKey == VirtualKey.GamepadY || args.VirtualKey == VirtualKey.GamepadRightShoulder)
            {
                args.Handled = true;
                padTriggersArriveAsKeys = true;
                ToggleNativePlayback();
                return;
            }
            if (args.VirtualKey == VirtualKey.GamepadX || args.VirtualKey == VirtualKey.GamepadLeftShoulder)
            {
                args.Handled = true;
                padTriggersArriveAsKeys = true;
                if (diagnosticsPanel != null)
                {
                    diagnosticsPanel.Visibility = diagnosticsPanel.Visibility == Visibility.Visible
                        ? Visibility.Collapsed
                        : Visibility.Visible;
                }
                return;
            }

            string jsKey = MapGamepadKey(args.VirtualKey);
            if (jsKey == null) return;
            args.Handled = true;

            // SPIKE, S4. Whether a direction key still reaches the page is only half the
            // question - the other half is whether XAML moved logical focus off the WebView2
            // now that the tree has more than one control in it. If this ever reports anything
            // other than WebView2, the focus-trap risk is live and Phase 2's "keep the WebView
            // the only focusable control" mitigation isn't holding.
            if (nativeSpike?.IsPlaying == true)
            {
                object focused = FocusManager.GetFocusedElement();
                Log($"key {args.VirtualKey} -> {jsKey}, focus={focused?.GetType().Name ?? "null"}");
            }

            _ = webView?.CoreWebView2?.ExecuteScriptAsync(
                $"document.dispatchEvent(new KeyboardEvent('keydown', {{ key: '{jsKey}', bubbles: true, composed: true }}));");
        }

        private static string MapGamepadKey(VirtualKey key)
        {
            switch (key)
            {
                case VirtualKey.GamepadDPadUp:
                case VirtualKey.GamepadLeftThumbstickUp:
                    return "ArrowUp";
                case VirtualKey.GamepadDPadDown:
                case VirtualKey.GamepadLeftThumbstickDown:
                    return "ArrowDown";
                case VirtualKey.GamepadDPadLeft:
                case VirtualKey.GamepadLeftThumbstickLeft:
                    return "ArrowLeft";
                case VirtualKey.GamepadDPadRight:
                case VirtualKey.GamepadLeftThumbstickRight:
                    return "ArrowRight";
                case VirtualKey.GamepadA:
                    return "Enter";
                case VirtualKey.GamepadB:
                    return "Escape";
                default:
                    return null;
            }
        }
    }
}
