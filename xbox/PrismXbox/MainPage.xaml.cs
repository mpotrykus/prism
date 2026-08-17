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
    /// Layout is a Grid rather than the WebView2 alone so a video surface can sit behind the
    /// page: MediaPlayerElement at z=0, WebView2 (transparent) at z=1.
    /// </summary>
    public sealed partial class MainPage : Page
    {
        private WebView2 webView;

        private NativePlayerHost playerHost;
        private PlayerBridge playerBridge;

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

            // Confirmed on real hardware: opening the Xbox Guide (Nexus button) does NOT stop
            // gamepad input from reaching this app underneath it - neither this native
            // CoreWindow.KeyDown forwarder nor focus-nav.js's own Gamepad API poller (which reads
            // raw HID state directly, independent of any window message) know the Guide has taken
            // over, so a D-pad move or A/B press drives both the Guide overlay and the app behind
            // it at once. CoreWindow.Activated firing Deactivated is the documented signal for
            // "another surface owns input now" - gating the native forwarder on it here, and
            // relaying the same state to the page (OnCoreWindowActivated below) so the JS-side
            // poller can gate itself too, since that poller can't observe CoreWindow state on its
            // own.
            Windows.UI.Xaml.Window.Current.CoreWindow.Activated += OnCoreWindowActivated;

            // Confirmed on real hardware: pressing B to close Xbox's on-screen keyboard (shown
            // automatically by WebView2 when an HTML text input gets focus) is consumed entirely
            // by the platform before it reaches this app - neither OnCoreWindowKeyDown above nor
            // focus-nav.js's Gamepad API poller ever see that press, and the web-standard
            // VirtualKeyboard.geometrychange event the JS side also listens for (nav.js's
            // wireVirtualKeyboardDismiss) does not fire on this WebView2 build either, leaving the
            // search input focused with no page-level event of any kind. InputPane is the actual
            // Windows signal for on-screen-keyboard visibility, independent of both of those and
            // of whatever control/button triggered the dismissal.
            Windows.UI.ViewManagement.InputPane.GetForCurrentView().Hiding += OnInputPaneHiding;

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

            // Xbox's "mouse mode" (Application.RequiresPointerMode, set to WhenRequested in
            // App.xaml.cs) is a per-control override, not just an app-wide default - controls
            // like WebView/WebView2 that need free pointer movement to be usable at all are
            // exactly the ones Microsoft's own gamepad-interactions guidance calls out as
            // needing mouse mode, so leaving this control's own RequiresPointer unset let it
            // keep engaging mouse mode regardless of the app-level setting above. That's what
            // was driving the left stick as a continuous virtual pointer/scroll gesture behind
            // every modal - entirely outside focus-nav.js's keydown pipeline, which is why
            // fixing that pipeline's cancelable flag had no effect. D-pad was never the
            // "move the pointer" input in mouse mode, which is why it stayed clean. Every
            // D-pad/thumbstick keyboard-equivalent nav this app relies on (OnCoreWindowKeyDown,
            // focus-nav.js's Gamepad API poller) is independent of mouse mode, so this is safe
            // to force off entirely rather than requesting it per-page.
            webView.RequiresPointer = Windows.UI.Xaml.Controls.RequiresPointer.Never;

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
            // without a "method" field, so it coexists with the diagnostic channel below on one
            // message channel.
            playerBridge = new PlayerBridge(coreWebView, playerHost, Log);

            // The diagnostic channel's own half of that shared message channel (messages carrying
            // "type" rather than "method").
            coreWebView.WebMessageReceived += OnWebMessageReceived;

            // Forwards window.onerror, unhandled rejections, and console.error/warn to the native
            // log, so a JS exception is readable on the console's own screen without remote DevTools
            // - this is what actually found the Shader Upscaling/Color Boost shader-model bug during
            // Effects bring-up. Must be awaited before navigation, or the document it should run in
            // has already been created.
            await coreWebView.AddScriptToExecuteOnDocumentCreatedAsync(@"
                (function () {
                  // Tells src/player/core/platform.js this is the Xbox shell, before any app module
                  // evaluates. platformTag() then reports 'xbox', which routes playback to
                  // xbox-bridge.js and makes Plex serve progressive output instead of HLS.
                  window.__prismXboxNativePlayer = true;
                  // Default true: this script runs once per new document, before any
                  // CoreWindow.Activated transition has necessarily happened again, so a
                  // mid-session navigation/reload shouldn't start the page assuming input is
                  // suspended when nothing actually suspended it.
                  window.__prismXboxInputActive = true;
                  var wv = window.chrome && window.chrome.webview;
                  if (!wv) return;
                  var send = function (type, message) {
                    // Stringified, not an object - an object payload silently never arrives at
                    // CoreWebView2.WebMessageReceived on this WebView2 runtime, confirmed during
                    // Phase 0 bring-up.
                    try { wv.postMessage(JSON.stringify({ type: type, message: String(message) })); } catch (e) {}
                  };
                  window.addEventListener('error', function (e) {
                    send('jsError', (e && e.message) + ' @ ' + (e && e.filename) + ':' + (e && e.lineno));
                  });
                  window.addEventListener('unhandledrejection', function (e) {
                    send('jsError', 'unhandled rejection: ' + (e && e.reason));
                  });
                  ['error', 'warn'].forEach(function (level) {
                    var original = console[level];
                    console[level] = function () {
                      send('jsConsole', level + ': ' + Array.prototype.join.call(arguments, ' '));
                      original.apply(console, arguments);
                    };
                  });
                })();
            ");

            // The WebView2 profile persists across deployments, and the app registers a service
            // worker (sw.js) - clearing these avoids a stale cached bundle looking identical to a
            // real regression. CacheStorage and DiskCache ONLY. Not AllDomStorage/IndexedDb/
            // LocalStorage: those hold the Plex token (vault.js) and all settings, so clearing them
            // would sign the user out on every launch.
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

        private Grid BuildLayout()
        {
            // Marshalled to the UI thread, because MediaPlayer and MediaPlaybackSession raise their
            // events on background threads while CoreWebView2.PostWebMessageAsJson may only be called
            // on the UI thread. Without this every emit fails with 0x802A000C and JS receives nothing -
            // native playback runs perfectly and the page never hears about it.
            playerHost = new NativePlayerHost(
                (name, json) => _ = Dispatcher.RunAsync(
                    CoreDispatcherPriority.Normal, () => playerBridge?.Emit(name, json)),
                Log);

            var grid = new Grid
            {
                // MediaPlayerElement's default control template hardcodes its root Border's
                // Background to "Transparent" directly in XAML - it is NOT template-bound to the
                // control's own Background property, so setting Background on the element itself
                // (tried first) is a no-op. The Stretch=Uniform letterbox gap is genuinely
                // transparent and falls through to whatever is behind it in the visual tree - this
                // Grid - so paint it black here instead of relying on the element's own Background.
                Background = new SolidColorBrush(Colors.Black),
            };
            grid.Children.Add(playerHost.Element);
            grid.Children.Add(webView);

            return grid;
        }

        private void RestoreDisplayMode()
        {
            // Deliberately not awaited: a Suspending handler without a deferral has no guarantee of
            // outliving the await, and the display-mode change is a system-level call that completes on
            // its own. Nothing here depends on the result.
            _ = playerHost?.RestoreDisplayAsync();
        }

        // Every native call site (PlayerBridge, NativePlayerHost, HdrDisplayController,
        // EffectSettings.EffectLog) and the JS console/error forwarder below still funnel through
        // this one sink - visible in Visual Studio's Output window during a Remote Machine debug
        // session, same as any other Debug.WriteLine.
        private void Log(string line)
        {
            Debug.WriteLine($"[xbox] {line}");
        }

        private void OnWebMessageReceived(CoreWebView2 sender, CoreWebView2WebMessageReceivedEventArgs args)
        {
            // Everything below is wrapped because an exception thrown out of a WinRT event handler
            // is swallowed at the ABI boundary - the handler would appear never to have run, which
            // is indistinguishable from the message never arriving.
            try
            {
                DispatchWebMessage(args);
            }
            catch (Exception ex)
            {
                Log($"web message handler threw: {ex.GetType().Name} / {ex.Message}");
            }
        }

        private void DispatchWebMessage(CoreWebView2WebMessageReceivedEventArgs args)
        {
            // Accept either envelope. JS posts a JSON string (WebMessageAsJson would then be that
            // string, JSON-quoted, and TryGetWebMessageAsString gives it unwrapped), but an object
            // post is still handled so this doesn't depend on which form works.
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

            // "" not null as the default: a WinRT HSTRING cannot be null, so GetNamedString throws
            // ArgumentNullException on a null default rather than returning it.
            // Messages carrying "method" belong to PlayerBridge, which shares this channel - ignored
            // silently rather than logged, so the real bridge's traffic doesn't read as an error here.
            if (root.ContainsKey("method")) return;

            string type = root.GetNamedString("type", "");
            switch (type)
            {
                case "jsError":
                    Log($"JS ERROR: {root.GetNamedString("message", "(none)")}");
                    break;
                case "jsConsole":
                    Log($"JS {root.GetNamedString("message", "(none)")}");
                    break;
                default:
                    break;
            }
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
        // How long a key must be held before it starts repeating, and how often it repeats
        // after that - matches focus-nav.js's own REPEAT_DELAY_MS/REPEAT_RATE_MS exactly, so
        // a held d-pad/thumbstick direction paces the same way here as it does through that
        // module's own Gamepad API poller (used everywhere this native path doesn't cover -
        // search/chapter-skip/seek/menu, see MapGamepadKey below).
        private const double RepeatDelayMs = 400;
        private const double RepeatRateMs = 150;
        private readonly Dictionary<VirtualKey, DateTime> _repeatDelayStart = new Dictionary<VirtualKey, DateTime>();
        private readonly Dictionary<VirtualKey, DateTime> _lastForwardedAt = new Dictionary<VirtualKey, DateTime>();

        private bool _inputActive = true;

        // Deactivated fires when the Guide (or any other system surface) takes over input;
        // CodeActivated/PointerActivated fire when it closes and this app owns input again.
        // Resetting the repeat-timing dictionaries on every transition means a direction still
        // held from before the Guide opened doesn't read as "held long enough to repeat" the
        // instant input resumes - it has to be freshly held past RepeatDelayMs again, same as a
        // brand-new press.
        private void OnCoreWindowActivated(CoreWindow sender, WindowActivatedEventArgs args)
        {
            _inputActive = args.WindowActivationState != CoreWindowActivationState.Deactivated;
            _repeatDelayStart.Clear();
            _lastForwardedAt.Clear();

            string activeLiteral = _inputActive ? "true" : "false";
            _ = webView?.CoreWebView2?.ExecuteScriptAsync(
                $"window.__prismXboxInputActive = {activeLiteral}; " +
                $"document.dispatchEvent(new CustomEvent('xbox-input-active-change', {{ detail: {{ active: {activeLiteral} }} }}));");
        }

        // Dispatched as a plain document-level CustomEvent rather than through the
        // window.__prismXboxInputActive/xbox-input-active-change channel above - that one
        // means "something else now owns gamepad input," which isn't true here (the keyboard
        // never stole CoreWindow activation in the first place, per the comment on the
        // subscription above). nav.js's wireVirtualKeyboardDismiss listens for this event the
        // same way it already listens for the web VirtualKeyboard API's own geometrychange -
        // whichever of the two actually fires on a given build drives the same JS-side handler.
        private void OnInputPaneHiding(InputPane sender, InputPaneVisibilityEventArgs args)
        {
            Log("InputPane hiding - forwarding xbox-keyboard-hiding to JS");
            _ = webView?.CoreWebView2?.ExecuteScriptAsync(
                "document.dispatchEvent(new CustomEvent('xbox-keyboard-hiding'));");
        }

        private void OnCoreWindowKeyDown(CoreWindow sender, KeyEventArgs args)
        {
            if (!_inputActive) return;

            string jsKey = MapGamepadKey(args.VirtualKey);
            if (jsKey == null) return;
            args.Handled = true;

            if (!ShouldForwardKeyDown(args)) return;

            // cancelable must be set explicitly - it defaults to false on a constructed event
            // (unlike a real trusted keydown), which makes focus-nav.js's own e.preventDefault()
            // a silent no-op and lets the browser's native arrow-key scroll run alongside every
            // handler here forwards - same gotcha focus-nav.js's own dispatchSyntheticKey already
            // documents and fixes for its JS-side gamepad poller; this native path needs the same
            // fix, since the left stick's analog dwell (see ShouldForwardKeyDown above) makes it
            // hit this path far more often than the d-pad's clean digital edge does.
            _ = webView?.CoreWebView2?.ExecuteScriptAsync(
                $"document.dispatchEvent(new KeyboardEvent('keydown', {{ key: '{jsKey}', bubbles: true, composed: true, cancelable: true }}));");
        }

        // Windows' own OS-level auto-repeat for a held gamepad-mapped VirtualKey fires at its
        // own, uncontrolled cadence - forwarding every repeat verbatim let a single quick
        // thumbstick flick register as two presses instead of one: an analog push dwells past
        // the deadzone threshold for tens of milliseconds even on a deliberately quick flick,
        // long enough for the OS to consider it a "repeat" at least once before release, unlike
        // the d-pad's clean, near-instant mechanical digital edge. That extra forwarded press
        // moved focus twice before the web app's smooth-scroll centering call for the first
        // move could settle, so it never visibly centered. Re-pacing repeats to
        // RepeatDelayMs/RepeatRateMs here - rather than trusting the OS's own repeat timer -
        // makes a quick flick collapse back to exactly one forwarded press, same as the d-pad,
        // while a genuine hold still repeats at a controlled, deliberate rate.
        private bool ShouldForwardKeyDown(KeyEventArgs args)
        {
            VirtualKey key = args.VirtualKey;
            DateTime now = DateTime.UtcNow;

            if (!args.KeyStatus.WasKeyDown || !_repeatDelayStart.ContainsKey(key))
            {
                _repeatDelayStart[key] = now;
                _lastForwardedAt[key] = now;
                return true;
            }

            if ((now - _repeatDelayStart[key]).TotalMilliseconds < RepeatDelayMs) return false;
            if ((now - _lastForwardedAt[key]).TotalMilliseconds < RepeatRateMs) return false;

            _lastForwardedAt[key] = now;
            return true;
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
