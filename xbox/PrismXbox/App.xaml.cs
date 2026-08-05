using System;
using System.Diagnostics;
using Windows.ApplicationModel;
using Windows.ApplicationModel.Activation;
using Windows.UI.ViewManagement;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;
using Windows.UI.Xaml.Navigation;

namespace PrismXbox
{
    /// <summary>
    /// Provides application-specific behavior to supplement the default Application class.
    /// </summary>
    sealed partial class App : Application
    {
        public App()
        {
            this.InitializeComponent();
            this.Suspending += OnSuspending;

            // On Xbox, this hides the virtual mouse cursor so the app is driven by the gamepad
            // instead. This is exactly the kind of thing the Phase 3 validation checklist needs
            // to exercise against the WebView2 gamepad-focus-trap bug.
            this.RequiresPointerMode = ApplicationRequiresPointerMode.WhenRequested;

            // The WebView2 control's own draw color can briefly show before content loads. Match
            // the app shell's background so that doesn't produce a flash.
            Environment.SetEnvironmentVariable("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "FF0A0A0C");

            // Remote DevTools (Console/Elements/etc. from a PC's Edge/Chrome at
            // http://<xbox-ip>:9222) - there's no keyboard/mouse on the console itself to
            // drive WebView2's own F12 DevTools window, and this is the only way to see what
            // the page's JS actually observes (console.log, document.activeElement,
            // navigator.getGamepads()) on real hardware. The WinUI2 WebView2 XAML control
            // bundled here (2.8.7) has no API to pass CoreWebView2EnvironmentOptions directly -
            // this documented environment-variable override is WebView2's own fallback for
            // exactly that gap, and must be set before EnsureCoreWebView2Async() runs (same
            // requirement as WEBVIEW2_DEFAULT_BACKGROUND_COLOR above). Same "disable before
            // Store submission" bucket as MainPage's AreDevToolsEnabled.
            Environment.SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--remote-debugging-port=9222");

            // By default, XAML apps are scaled up 2x on Xbox. This disables that so the WebView2
            // control (and the web app inside it) renders at the device's native resolution.
            if (!ApplicationViewScaling.TrySetDisableLayoutScaling(true))
            {
                Debug.WriteLine("Error: Failed to disable layout scaling.");
            }
        }

        protected override void OnLaunched(LaunchActivatedEventArgs e)
        {
            Frame rootFrame = Window.Current.Content as Frame;

            if (rootFrame == null)
            {
                rootFrame = new Frame();
                rootFrame.NavigationFailed += OnNavigationFailed;
                Window.Current.Content = rootFrame;
            }

            if (e.PrelaunchActivated == false)
            {
                if (rootFrame.Content == null)
                {
                    rootFrame.Navigate(typeof(MainPage), e.Arguments);
                }
                Window.Current.Activate();
            }
        }

        void OnNavigationFailed(object sender, NavigationFailedEventArgs e)
        {
            throw new Exception("Failed to load Page " + e.SourcePageType.FullName);
        }

        private void OnSuspending(object sender, SuspendingEventArgs e)
        {
            var deferral = e.SuspendingOperation.GetDeferral();
            deferral.Complete();
        }
    }
}
