package com.acme.matrixpoc;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Phase 7 (PRIN-31): the JS bridge for calls on Android (`src/lib/native.ts`: startCallService / stopCallService /
 * setSpeakerphone). `start` requests POST_NOTIFICATIONS on Android 13+ first (a denied prompt still starts the
 * service: the notification is just hidden, AC-R9-5), then starts {@link CallForegroundService}. `setSpeakerphone`
 * is the AudioManager shim: earpiece (voice-call mode) or loudspeaker. The notification's "Hang up" action arrives
 * in MainActivity as an intent and is forwarded here as the `hangup` event.
 */
@CapacitorPlugin(
    name = "CallService",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class CallServicePlugin extends Plugin {
    static CallServicePlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationsResult");
            return;
        }
        startService(call);
    }

    @PermissionCallback
    private void notificationsResult(PluginCall call) {
        startService(call); // denied is fine: the service runs without a visible notification
    }

    private void startService(PluginCall call) {
        Context ctx = getContext();
        Intent intent = new Intent(ctx, CallForegroundService.class)
            .setAction(CallForegroundService.ACTION_START)
            .putExtra(CallForegroundService.EXTRA_ROOM_NAME, call.getString("roomName", ""));
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(intent);
            else ctx.startService(intent);
            JSObject ret = new JSObject();
            ret.put("notifications", getPermissionState("notifications") == PermissionState.GRANTED);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not start the call service: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context ctx = getContext();
        ctx.stopService(new Intent(ctx, CallForegroundService.class));
        setMode(false);
        call.resolve();
    }

    @PluginMethod
    public void setSpeakerphone(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        try {
            setMode(true);
            AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                AudioDeviceInfo target = null;
                for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
                    int type = d.getType();
                    if (on && type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) target = d;
                    if (!on && type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) target = d;
                }
                if (target != null) am.setCommunicationDevice(target);
                else if (!on) am.clearCommunicationDevice();
            } else {
                am.setSpeakerphoneOn(on);
            }
            JSObject ret = new JSObject();
            ret.put("on", on);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not switch the audio route: " + e.getMessage());
        }
    }

    /** MODE_IN_COMMUNICATION gives the WebRTC audio path echo cancellation and the earpiece by default. */
    private void setMode(boolean inCall) {
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (am == null) return;
        am.setMode(inCall ? AudioManager.MODE_IN_COMMUNICATION : AudioManager.MODE_NORMAL);
        if (!inCall && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.clearCommunicationDevice();
    }

    /** Called by MainActivity when the notification's "Hang up" action fires. */
    void onHangup() {
        notifyListeners("hangup", new JSObject());
    }
}
