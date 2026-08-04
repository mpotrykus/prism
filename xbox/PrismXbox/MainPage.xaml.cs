using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;
using System;
using System.Diagnostics;
using Windows.UI;
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
    }
}
