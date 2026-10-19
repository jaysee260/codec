package com.acme.matrixpoc;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;

/**
 * Phase 7 (PRIN-31): keeps the microphone and the WebView alive while a call is active and the screen is locked or
 * the app is in the background. Started by {@link CallServicePlugin#start} only while the activity is visible (Android
 * 12+ refuses foreground-service starts from the background), stopped on leave. Shows the persistent "Codec call"
 * notification with a "Hang up" action, which comes back to the plugin as the JS `hangup` event.
 */
public class CallForegroundService extends Service {
    public static final String ACTION_START = "com.acme.matrixpoc.call.START";
    public static final String ACTION_STOP = "com.acme.matrixpoc.call.STOP";
    public static final String ACTION_HANGUP = "com.acme.matrixpoc.call.HANGUP";
    public static final String EXTRA_ROOM_NAME = "roomName";
    public static final String CHANNEL_ID = "codec_call";
    public static final int NOTIFICATION_ID = 7001;

    private PowerManager.WakeLock wakeLock;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_STOP : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        String roomName = intent.getStringExtra(EXTRA_ROOM_NAME);
        Notification notification = buildNotification(roomName == null ? "" : roomName);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) { // FOREGROUND_SERVICE_TYPE_MICROPHONE is API 30+
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        acquireWakeLock();
        return START_NOT_STICKY;
    }

    private Notification buildNotification(String roomName) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Calls", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Shown while a Codec call is active");
            nm.createNotificationChannel(channel);
        }
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openIntent = PendingIntent.getActivity(this, 1, open, flags);
        Intent hangup = new Intent(this, MainActivity.class).setAction(ACTION_HANGUP).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent hangupIntent = PendingIntent.getActivity(this, 2, hangup, flags);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setContentTitle("Codec call")
            .setContentText(roomName.isEmpty() ? "Call in progress" : roomName)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(openIntent)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Hang up", hangupIntent)
            .build();
    }

    private void acquireWakeLock() {
        if (wakeLock != null) return;
        PowerManager pm = getSystemService(PowerManager.class);
        if (pm == null) return;
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "codec:call");
        wakeLock.acquire(4 * 60 * 60 * 1000L); // safety cap: 4 h
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
