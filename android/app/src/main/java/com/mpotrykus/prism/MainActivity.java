package com.mpotrykus.prism;

import android.content.Intent;
import android.os.Bundle;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private static MainActivity instance;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        SplashScreen.installSplashScreen(this);
        registerPlugin(NativePlayerPlugin.class);
        super.onCreate(savedInstanceState);
        instance = this;
    }

    /* PlayerActivity calls this from its own onStop() when it's closed while pinned in
       PiP (see that method's comment) - by that point moveTaskToBack has already sent
       this Activity's task to the background rather than finishing it (so a normal
       fullscreen exit can still resume it), which otherwise left it lingering as its own
       entry in the Recents/"apps list" UI even after the player it was hosting was gone.
       finishAndRemoveTask() (not plain finish()) is what actually drops that Recents
       entry, not just the Activity itself. */
    static void finishIfRunning() {
        if (instance != null) {
            instance.finishAndRemoveTask();
        }
    }

    @Override
    public void onDestroy() {
        if (instance == this) {
            instance = null;
        }
        super.onDestroy();
    }

    /* PlayerActivity shares this Activity's task (started via startActivityForResult, no
       FLAG_ACTIVITY_NEW_TASK - that flag would silently break onActivityResult delivery
       to NativePlayerPlugin's call.resolve()). That means Android's documented PiP
       behavior (see PlayerActivity.isActiveAndNotFinishing's comment) resumes this WebView
       UI right behind the shrunken player. Bouncing straight back to the background here
       is what makes the floating player the only interactive surface while it's pinned,
       instead of also exposing the browsing UI as a separate usable window underneath it.

       Also re-launches PlayerActivity itself (singleTop, so this hits its existing pinned
       instance via onNewIntent rather than recreating it) with REORDER_TO_FRONT - without
       this, tapping the app icon while pinned just bounced straight back to whatever was
       behind the pip (home screen), which read as "the app closes" instead of "the app
       resumed the player" the way e.g. YouTube's icon tap re-expands its PiP video. */
    @Override
    public void onResume() {
        super.onResume();
        if (PlayerActivity.isActiveAndNotFinishing()) {
            Intent expandPlayer = new Intent(this, PlayerActivity.class);
            expandPlayer.setFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(expandPlayer);
            moveTaskToBack(false);
        }
    }
}
