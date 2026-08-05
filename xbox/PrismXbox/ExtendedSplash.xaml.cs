using Windows.UI.Core;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;

namespace PrismXbox
{
    /// <summary>
    /// Replaces the system splash screen (which shows its 620x300 image at native size,
    /// tiny and low-res on a TV) with the same wordmark sized relative to the actual window,
    /// so it reads clearly at typical 10-foot viewing distance. Stays on screen until
    /// MainPage's WebView2 content is ready - see App.xaml.cs's OnLaunched and MainPage's
    /// ContentReady event.
    /// </summary>
    public sealed partial class ExtendedSplash : Page
    {
        private const double LogoWidthFraction = 0.32;

        public ExtendedSplash()
        {
            InitializeComponent();

            Window.Current.SizeChanged += OnWindowSizeChanged;
            SizeLogo(Window.Current.Bounds.Width);
        }

        private void OnWindowSizeChanged(object sender, WindowSizeChangedEventArgs e)
        {
            SizeLogo(e.Size.Width);
        }

        private void SizeLogo(double windowWidth)
        {
            LogoImage.Width = windowWidth * LogoWidthFraction;
        }
    }
}
