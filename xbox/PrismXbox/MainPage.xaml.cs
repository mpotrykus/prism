using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;
using System;
using System.Diagnostics;
using Windows.System;
using Windows.UI;
using Windows.UI.Core;
using Windows.UI.ViewManagement;
using Windows.UI.Xaml.Controls;
using Windows.UI.Xaml.Media;

namespace PrismXbox
{
    /// <summary>
    /// Shell-only page: hosts the built Prism web app (bundled under www/, synced from the
    /// root repo's `npm run xbox:sync`) full-screen inside a WebView2 control. No native
    /// player bridge lives here yet - that's a follow-up phase, once the two open WebView2-on-
    /// Xbox risks (gamepad focus trap, fixed-version-runtime Store cert snag) are validated on
    /// real hardware.
    /// </summary>
    public sealed partial class MainPage : Page
    {
        private WebView2 webView;

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
            this.Content = webView;
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

            webView.Source = new Uri(InitialUri);
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
