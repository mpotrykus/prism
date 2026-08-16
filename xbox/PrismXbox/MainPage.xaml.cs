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
    /// page: MediaPlayerElement at z=0, WebView2 (transparent) at z=1, diagnostics on top.
    /// </summary>
    public sealed partial class MainPage : Page
    {
        private WebView2 webView;

        private NativePlayerHost playerHost;
        private PlayerBridge playerBridge;

        private TextBlock diagnostics;
        private Border diagnosticsPanel;
        private readonly List<string> diagnosticLines = new List<string>();
        private const int MaxDiagnosticLines = 18;
        private string lastLoggedMessage;
        private int repeatCount;

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

        // The diagnostics TextBlock is added last so it stays readable over both the video and the
        // WebView2. Neither the MediaPlayerElement (IsTabStop=false) nor the TextBlock is focusable,
        // which is what keeps webView the only focusable control in the tree - the invariant
        // OnCoreWindowKeyDown's comment below depends on.
        private Grid BuildLayout()
        {
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
                Visibility = Visibility.Visible,
            };

            // Marshalled to the UI thread, because MediaPlayer and MediaPlaybackSession raise their
            // events on background threads while CoreWebView2.PostWebMessageAsJson may only be called
            // on the UI thread. Without this every emit fails with 0x802A000C and JS receives nothing -
            // native playback runs perfectly and the page never hears about it. Log() already does
            // this, which is exactly why the log stays readable even if the bridge itself goes silent.
            playerHost = new NativePlayerHost(
                (name, json) => _ = Dispatcher.RunAsync(
                    CoreDispatcherPriority.Normal, () => playerBridge?.Emit(name, json)),
                Log);

            var grid = new Grid();
            grid.Children.Add(playerHost.Element);
            grid.Children.Add(webView);
            grid.Children.Add(diagnosticsPanel);

            Log("X = hide this panel.");
            return grid;
        }

        private void RestoreDisplayMode()
        {
            // Deliberately not awaited: a Suspending handler without a deferral has no guarantee of
            // outliving the await, and the display-mode change is a system-level call that completes on
            // its own. Nothing here depends on the result.
            _ = playerHost?.RestoreDisplayAsync();
        }

        // Rendered on screen rather than to Debug output because the point is to read results on a
        // TV without depending on remote DevTools reaching the console.
        private void Log(string line)
        {
            Debug.WriteLine($"[xbox] {line}");
            _ = Dispatcher.RunAsync(CoreDispatcherPriority.Low, () =>
            {
                // Coalesce consecutive identical messages into "(xN)" rather than appending each -
                // a repeated line (e.g. a per-frame diagnostic) would otherwise push older, more
                // useful lines straight out of the panel's fixed line budget.
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
        private void OnCoreWindowKeyDown(CoreWindow sender, KeyEventArgs args)
        {
            // X and LeftShoulder are unmapped below, so they're free to toggle the diagnostics
            // panel without colliding with anything the app uses (Y = search, RightShoulder = next
            // chapter, Menu/Start = options menu - see focus-nav.js/plex-player.js).
            if (args.VirtualKey == VirtualKey.GamepadX || args.VirtualKey == VirtualKey.GamepadLeftShoulder)
            {
                args.Handled = true;
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
