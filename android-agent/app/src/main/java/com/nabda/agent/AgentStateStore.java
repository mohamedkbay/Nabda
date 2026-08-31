package com.nabda.agent;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.SharedPreferences;

import java.text.DateFormat;
import java.util.Date;

/** Non-sensitive state used to keep the single screen current. */
public final class AgentStateStore {
    private static final String STORE_NAME = "nabda_agent_state";
    private static final String RUNNING = "running";
    private static final String STATUS = "status";
    private static final String LAST_ACTIVITY = "last_activity";
    private static final String LIVE_CONFIRMED = "live_confirmed";

    private final SharedPreferences preferences;

    public AgentStateStore(Context context) {
        preferences = context.getApplicationContext().getSharedPreferences(STORE_NAME, Context.MODE_PRIVATE);
    }

    public void markStarting() {
        update(true, "Connecting…", "Starting securely");
    }

    public void markConnected(String activity) {
        update(true, "Connected", activity);
    }

    public void markWaiting(String status, String activity) {
        update(true, status, activity);
    }

    public void markStopped() {
        update(false, "Offline", "Agent stopped");
    }

    public void markRejected(String message) {
        update(false, "Offline", message);
    }

    public void markOffline(String message) {
        update(false, "Offline", message);
    }

    public void recordConnectionTest(boolean connected, String activity) {
        Snapshot current = snapshot();
        update(current.running, connected ? "Connected" : "Offline", activity);
    }

    public Snapshot snapshot() {
        return new Snapshot(
                preferences.getBoolean(RUNNING, false),
                preferences.getString(STATUS, "Offline"),
                preferences.getString(LAST_ACTIVITY, "Nothing yet"));
    }

    @SuppressLint("ApplySharedPref") // Must be durable before the foreground service checks the gate.
    public void setLiveConfirmed(boolean confirmed) {
        preferences.edit().putBoolean(LIVE_CONFIRMED, confirmed).commit();
    }

    public boolean isLiveConfirmed() {
        return preferences.getBoolean(LIVE_CONFIRMED, false);
    }

    private void update(boolean running, String status, String activity) {
        String timestamp = DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date());
        preferences.edit()
                .putBoolean(RUNNING, running)
                .putString(STATUS, status)
                .putString(LAST_ACTIVITY, activity + " · " + timestamp)
                .apply();
    }

    public static final class Snapshot {
        public final boolean running;
        public final String status;
        public final String lastActivity;

        Snapshot(boolean running, String status, String lastActivity) {
            this.running = running;
            this.status = status;
            this.lastActivity = lastActivity;
        }
    }
}
