package com.acme.matrixpoc;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CallServicePlugin.class); // Phase 7: foreground call service + speakerphone shim
        super.onCreate(savedInstanceState);
        handleHangup(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleHangup(intent);
    }

    /** The call notification's "Hang up" action opens the activity with this action; forward it to JS. */
    private void handleHangup(Intent intent) {
        if (intent != null && CallForegroundService.ACTION_HANGUP.equals(intent.getAction()) && CallServicePlugin.instance != null) {
            CallServicePlugin.instance.onHangup();
            intent.setAction(null);
        }
    }
}
