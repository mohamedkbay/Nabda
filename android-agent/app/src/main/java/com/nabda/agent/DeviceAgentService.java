package com.nabda.agent;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.IBinder;
import android.net.Uri;

import org.json.JSONException;
import org.json.JSONObject;

import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public final class DeviceAgentService extends Service {
    private static final String CHANNEL_ID = "nabda_phone_connection";
    private static final int NOTIFICATION_ID = 7001;
    private static final long DEFAULT_POLL_MS = 10_000;
    private static final long HEARTBEAT_MS = 60_000;

    private final AtomicBoolean loopStarted = new AtomicBoolean(false);
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private volatile boolean stopping;
    private SecureSettings secureSettings;
    private AgentStateStore stateStore;
    private MessageDispatcher dispatcher;
    private NotificationManager notifications;
    private long nextHeartbeatAt;

    @Override
    public void onCreate() {
        super.onCreate();
        secureSettings = new SecureSettings(this);
        stateStore = new AgentStateStore(this);
        dispatcher = MessageDispatcherFactory.create();
        notifications = getSystemService(NotificationManager.class);
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTIFICATION_ID, buildNotification(getString(R.string.notification_connecting)));
        if (loopStarted.compareAndSet(false, true)) {
            executor.execute(this::runLoop);
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopping = true;
        executor.shutdownNow();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void runLoop() {
        while (!stopping) {
            long delay = DEFAULT_POLL_MS;
            SecureSettings.Credentials credentials = secureSettings.loadCredentials();
            if (!credentials.isComplete()) {
                stateStore.markRejected("Connection settings are missing");
                stopSelf();
                return;
            }

            try {
                ApiClient api = new ApiClient(credentials.serverUrl, credentials.deviceToken);
                if (System.currentTimeMillis() >= nextHeartbeatAt) {
                    JSONObject heartbeatResponse = api.heartbeat(heartbeatBody());
                    delay = pollAfter(heartbeatResponse, delay);
                    nextHeartbeatAt = System.currentTimeMillis() + HEARTBEAT_MS;
                    updateNotification(getString(R.string.notification_connected));
                    stateStore.markConnected("Heartbeat confirmed — no SMS sent");
                }
                // Desktop-paired mode is intentionally heartbeat-only in this release.
                // It does not call claim/begin/event routes and cannot trigger dispatch.
            } catch (ApiClient.ApiException error) {
                if (error.isAuthenticationFailure()) {
                    stateStore.markRejected(error.getMessage());
                    stopSelf();
                    return;
                }
                stateStore.markWaiting("Offline", error.getMessage());
                delay = error.statusCode == 429 ? 30_000 : 15_000;
            } catch (Exception error) {
                stateStore.markWaiting("Offline", safeMessage(error));
                delay = 15_000;
            }

            if (!sleep(delay)) {
                return;
            }
        }
    }

    /** Returns true when an existing acknowledgement occupied this cycle. */
    private boolean retryPendingEvent(ApiClient api) throws Exception {
        JSONObject pending = secureSettings.loadPendingEvent();
        if (pending == null) {
            return false;
        }
        String messageId = pending.getString("message_id");
        JSONObject response;
        try {
            response = api.post("/local/v1/device/messages/" + Uri.encode(messageId) + "/events", pending.getJSONObject("payload"));
        } catch (ApiClient.ApiException error) {
            if (error.isSafetyRejection()) {
                secureSettings.clearPendingEvent();
                stateStore.markConnected("Expired acknowledgement discarded safely");
                return true;
            }
            throw error;
        }
        if (!response.optBoolean("accepted", false)) {
            throw new JSONException("Event was not accepted");
        }
        secureSettings.clearPendingEvent();
        if (BuildConfig.SIMULATION_ONLY && "simulation_only".equals(response.optString("failure_code"))) {
            stateStore.markConnected("Simulation complete — no SMS sent");
        } else {
            stateStore.markConnected(response.optBoolean("duplicate", false)
                    ? "Message result already recorded"
                    : "Message result recorded");
        }
        return true;
    }

    /** Returns true when a claimed message occupied this cycle. */
    private boolean resumePendingDispatch(ApiClient api) throws Exception {
        JSONObject pending = secureSettings.loadPendingDispatch();
        if (pending == null) {
            return false;
        }
        ClaimedMessage message = ClaimedMessage.fromJson(pending.getJSONObject("message"));
        String attemptId = pending.getString("attempt_id");
        String phase = pending.optString("phase", "claimed");

        if ("dispatching".equals(phase)) {
            // Never retry an uncertain carrier operation after process death; duplicate prevention wins.
            JSONObject event = eventPayload(message, attemptId, "failed", null,
                    "agent_restart_unknown", "The app restarted during dispatch; the message was not retried.");
            persistEvent(message.id, event);
            secureSettings.clearPendingDispatch();
            retryPendingEvent(api);
            return true;
        }

        if ("claimed".equals(phase)) {
            JSONObject begin = new JSONObject();
            begin.put("lease_token", message.leaseToken);
            begin.put("attempt_id", attemptId);
            begin.put("simulated", BuildConfig.SIMULATION_ONLY);
            final JSONObject beginResponse;
            try {
                beginResponse = api.post("/local/v1/device/messages/" + Uri.encode(message.id) + "/begin", begin);
            } catch (ApiClient.ApiException error) {
                if (error.isSafetyRejection() || error.statusCode == 429) {
                    secureSettings.clearPendingDispatch();
                    stateStore.markConnected("Send authorization declined safely");
                    return true;
                }
                throw error;
            }
            if (!beginResponse.optBoolean("authorized", false)) {
                secureSettings.clearPendingDispatch();
                stateStore.markConnected("Send authorization declined safely");
                return true;
            }
            pending.put("phase", "authorized");
            secureSettings.savePendingDispatch(pending);
        }

        pending.put("phase", "dispatching");
        secureSettings.savePendingDispatch(pending);
        JSONObject event;
        try {
            DispatchResult result = dispatcher.dispatch(this, message);
            event = eventPayload(message, attemptId, result.status, result.providerMessageId, null, null);
        } catch (Exception error) {
            event = eventPayload(message, attemptId, "failed", null,
                    "agent_dispatch_failed", safeMessage(error));
        }
        persistEvent(message.id, event);
        secureSettings.clearPendingDispatch();
        retryPendingEvent(api);
        return true;
    }

    private void persistNewDispatch(ClaimedMessage message) throws Exception {
        JSONObject messageJson = new JSONObject();
        messageJson.put("id", message.id);
        messageJson.put("to", message.to);
        messageJson.put("body", message.body);
        messageJson.put("lease_token", message.leaseToken);
        messageJson.put("lease_expires_at", message.leaseExpiresAt);
        JSONObject pending = new JSONObject();
        pending.put("message", messageJson);
        pending.put("attempt_id", UUID.randomUUID().toString());
        pending.put("phase", "claimed");
        secureSettings.savePendingDispatch(pending);
    }

    private void persistEvent(String messageId, JSONObject event) throws Exception {
        JSONObject pending = new JSONObject();
        pending.put("message_id", messageId);
        pending.put("payload", event);
        secureSettings.savePendingEvent(pending);
    }

    private JSONObject eventPayload(
            ClaimedMessage message,
            String attemptId,
            String status,
            String providerMessageId,
            String errorCode,
            String errorMessage) throws JSONException {
        JSONObject event = new JSONObject();
        event.put("lease_token", message.leaseToken);
        event.put("attempt_id", attemptId);
        event.put("event_id", UUID.randomUUID().toString());
        event.put("status", status);
        event.put("occurred_at", Instant.now().toString());
        event.put("simulated", BuildConfig.SIMULATION_ONLY);
        if (providerMessageId != null) {
            event.put("provider_message_id", providerMessageId);
        }
        if (errorCode != null) {
            event.put("error_code", errorCode);
        }
        if (errorMessage != null) {
            event.put("error_message", errorMessage);
        }
        return event;
    }

    private JSONObject heartbeatBody() throws JSONException {
        try {
            return new JSONObject(LocalProtocol.heartbeat(
                    secureSettings.getOrCreateInstallationId(),
                    BuildConfig.VERSION_NAME));
        } catch (Exception error) {
            throw new JSONException("Could not load installation identity");
        }
    }

    private static long pollAfter(JSONObject response, long fallback) {
        long value = response.optLong("poll_after_ms", fallback);
        return Math.max(2_000, Math.min(value, 60_000));
    }

    private static String safeMessage(Exception error) {
        String message = error.getMessage();
        if (message == null || message.trim().isEmpty() || message.length() > 200) {
            return "Temporary connection problem";
        }
        return message;
    }

    private boolean sleep(long millis) {
        try {
            Thread.sleep(millis);
            return !stopping;
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    private void createNotificationChannel() {
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                getString(R.string.notification_channel_name),
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Keeps the company phone connected to its Nabda message queue.");
        notifications.createNotificationChannel(channel);
    }

    private Notification buildNotification(String text) {
        Intent openApp = new Intent(this, MainActivity.class);
        PendingIntent contentIntent = PendingIntent.getActivity(
                this,
                0,
                openApp,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_status)
                .setContentTitle(getString(R.string.notification_title))
                .setContentText(text)
                .setContentIntent(contentIntent)
                .setCategory(Notification.CATEGORY_SERVICE)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .build();
    }

    private void updateNotification(String text) {
        notifications.notify(NOTIFICATION_ID, buildNotification(text));
    }
}
