package com.mpotrykus.streaming;

import android.os.Bundle;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativePlayerPlugin.class);
        super.onCreate(savedInstanceState);
        /* App background is always dark (see plex-netflix-card.js's fixed dark gradient -
           there's no light theme variant), so status bar icons need to stay light/white
           unconditionally too, instead of following the system's day/night default and
           going invisible (dark-on-dark) whenever the device itself is in light mode. */
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.setAppearanceLightStatusBars(false);
    }
}
