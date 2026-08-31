package com.nabda.agent;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import com.google.zxing.integration.android.IntentIntegrator;
import com.google.zxing.integration.android.IntentResult;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private EditText serverUrlInput;
    private EditText pairingCodeInput;
    private CheckBox liveConsent;
    private Button scanQrButton;
    private Button pairButton;
    private Button connectButton;
    private Button testHeartbeatButton;
    private TextView pairedDeviceText;
    private TextView statusText;
    private TextView lastActivityText;
    private SecureSettings secureSettings;
    private AgentStateStore stateStore;
    private TransportGate transportGate;
    private volatile boolean pairingBusy;
    private volatile boolean heartbeatBusy;
    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();
    private final Handler refreshHandler = new Handler(Looper.getMainLooper());
    private final Runnable refreshTask = new Runnable() {
        @Override public void run() {
            refreshState();
            refreshHandler.postDelayed(this, 1_000);
        }
    };

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        secureSettings = new SecureSettings(this);
        stateStore = new AgentStateStore(this);
        serverUrlInput = findViewById(R.id.serverUrlInput);
        pairingCodeInput = findViewById(R.id.pairingCodeInput);
        liveConsent = findViewById(R.id.liveConsent);
        scanQrButton = findViewById(R.id.scanQrButton);
        pairButton = findViewById(R.id.pairButton);
        connectButton = findViewById(R.id.connectButton);
        testHeartbeatButton = findViewById(R.id.testHeartbeatButton);
        pairedDeviceText = findViewById(R.id.pairedDeviceText);
        statusText = findViewById(R.id.statusText);
        lastActivityText = findViewById(R.id.lastActivityText);
        transportGate = new TransportGate(this, liveConsent, stateStore);

        serverUrlInput.setText(secureSettings.loadCredentials().serverUrl);
        pairingCodeInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        transportGate.initialize();
        scanQrButton.setOnClickListener(view -> scanQr());
        pairButton.setOnClickListener(view -> pairFromManualFields());
        connectButton.setOnClickListener(view -> {
            if (stateStore.snapshot().running) stopAgent(); else startSavedAgent();
        });
        testHeartbeatButton.setOnClickListener(view -> testHeartbeat());
        handlePairingIntent(getIntent());
        refreshState();
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handlePairingIntent(intent);
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        IntentResult result = IntentIntegrator.parseActivityResult(requestCode, resultCode, data);
        if (result != null) {
            if (result.getContents() != null) acceptQr(result.getContents());
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override protected void onResume() {
        super.onResume();
        refreshHandler.post(refreshTask);
    }

    @Override protected void onPause() {
        refreshHandler.removeCallbacks(refreshTask);
        super.onPause();
    }

    @Override protected void onDestroy() {
        networkExecutor.shutdownNow();
        super.onDestroy();
    }

    private void scanQr() {
        new IntentIntegrator(this)
                .setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
                .setPrompt("Scan the pairing QR shown by Nabda Desktop")
                .setBeepEnabled(false)
                .setOrientationLocked(false)
                .initiateScan();
    }

    private void handlePairingIntent(Intent intent) {
        if (intent != null && Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getDataString() != null) {
            acceptQr(intent.getDataString());
            intent.setData(null);
        }
    }

    private void acceptQr(String rawQr) {
        try {
            PairingPayload payload = PairingPayload.fromQrUri(rawQr);
            serverUrlInput.setText(payload.serverUrl);
            pairingCodeInput.setText(payload.pairingCode);
            confirmPairing(payload);
        } catch (IllegalArgumentException error) {
            Toast.makeText(this, error.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void pairFromManualFields() {
        serverUrlInput.setError(null);
        pairingCodeInput.setError(null);
        try {
            confirmPairing(PairingPayload.fromManual(
                    serverUrlInput.getText().toString(), pairingCodeInput.getText().toString()));
        } catch (IllegalArgumentException error) {
            String message = error.getMessage();
            if (message != null && message.toLowerCase().contains("secret")) {
                pairingCodeInput.setError(message);
                pairingCodeInput.requestFocus();
            } else {
                serverUrlInput.setError(message);
                serverUrlInput.requestFocus();
            }
        }
    }

    private void confirmPairing(PairingPayload payload) {
        String desktopLabel = "manual".equals(payload.desktopId)
                ? "the Desktop at" : "Desktop " + payload.desktopId + " at";
        new AlertDialog.Builder(this)
                .setTitle("Pair this phone?")
                .setMessage("Connect to " + desktopLabel + "\n" + payload.serverUrl
                        + "\n\nContinue only if this is the computer in front of you. The one-time secret expires after five minutes.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Pair", (dialog, which) -> performPairing(payload))
                .show();
    }

    private void performPairing(PairingPayload payload) {
        setPairingBusy(true);
        networkExecutor.execute(() -> {
            try {
                String installationId = secureSettings.getOrCreateInstallationId();
                JSONObject request = new JSONObject(LocalProtocol.pairingClaim(
                        payload.pairingCode, phoneName(), installationId, BuildConfig.VERSION_NAME));
                PairingClient.Result result = new PairingClient().claim(payload.serverUrl, request);
                secureSettings.saveCredentials(payload.serverUrl, result.deviceId, result.deviceToken);
                runOnUiThread(() -> {
                    pairingCodeInput.setText("");
                    setPairingBusy(false);
                    Toast.makeText(this, "Phone paired. The device token is stored securely.", Toast.LENGTH_LONG).show();
                    transportGate.confirmThenRun(this::startAgentService);
                    refreshState();
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    pairingCodeInput.setText("");
                    setPairingBusy(false);
                    stateStore.markOffline(safeMessage(error));
                    Toast.makeText(this, safeMessage(error), Toast.LENGTH_LONG).show();
                    refreshState();
                });
            }
        });
    }

    private void startSavedAgent() {
        if (!secureSettings.loadCredentials().isComplete()) {
            Toast.makeText(this, "Pair this phone with Nabda Desktop first.", Toast.LENGTH_LONG).show();
            return;
        }
        transportGate.confirmThenRun(this::startAgentService);
    }

    private void startAgentService() {
        stateStore.markStarting();
        startForegroundService(new Intent(this, DeviceAgentService.class));
        refreshState();
    }

    private void stopAgent() {
        stopService(new Intent(this, DeviceAgentService.class));
        stateStore.markStopped();
        transportGate.onStopped();
        refreshState();
    }

    private void testHeartbeat() {
        SecureSettings.Credentials credentials = secureSettings.loadCredentials();
        if (!credentials.isComplete()) {
            Toast.makeText(this, "Pair this phone first.", Toast.LENGTH_LONG).show();
            return;
        }
        testHeartbeatButton.setEnabled(false);
        heartbeatBusy = true;
        networkExecutor.execute(() -> {
            try {
                JSONObject body = new JSONObject(LocalProtocol.heartbeat(
                        secureSettings.getOrCreateInstallationId(), BuildConfig.VERSION_NAME));
                JSONObject response = new ApiClient(credentials.serverUrl, credentials.deviceToken).heartbeat(body);
                JSONObject data = response.optJSONObject("data");
                JSONObject value = data == null ? response : data;
                if (!"connected".equalsIgnoreCase(value.optString("status", "connected"))) {
                    throw new IllegalStateException("Desktop did not confirm this phone.");
                }
                runOnUiThread(() -> {
                    stateStore.recordConnectionTest(true, "Heartbeat confirmed — no SMS sent");
                    testHeartbeatButton.setEnabled(true);
                    heartbeatBusy = false;
                    Toast.makeText(this, "Connected. Test heartbeat sent no SMS.", Toast.LENGTH_LONG).show();
                    refreshState();
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    stateStore.recordConnectionTest(false, safeMessage(error));
                    testHeartbeatButton.setEnabled(true);
                    heartbeatBusy = false;
                    Toast.makeText(this, safeMessage(error), Toast.LENGTH_LONG).show();
                    refreshState();
                });
            }
        });
    }

    private void setPairingBusy(boolean busy) {
        pairingBusy = busy;
        scanQrButton.setEnabled(!busy);
        pairButton.setEnabled(!busy);
        serverUrlInput.setEnabled(!busy);
        pairingCodeInput.setEnabled(!busy);
    }

    private void refreshState() {
        AgentStateStore.Snapshot snapshot = stateStore.snapshot();
        SecureSettings.Credentials credentials = secureSettings.loadCredentials();
        statusText.setText(snapshot.status);
        lastActivityText.setText(snapshot.lastActivity);
        pairedDeviceText.setText(credentials.isComplete()
                ? "Paired device: " + credentials.deviceId : "No phone pairing saved");
        connectButton.setText(snapshot.running ? R.string.stop_agent : R.string.connect_start);
        connectButton.setEnabled(credentials.isComplete());
        testHeartbeatButton.setEnabled(credentials.isComplete() && !heartbeatBusy);
        scanQrButton.setEnabled(!snapshot.running && !pairingBusy);
        pairButton.setEnabled(!snapshot.running && !pairingBusy);
        serverUrlInput.setEnabled(!snapshot.running && !pairingBusy);
        pairingCodeInput.setEnabled(!snapshot.running && !pairingBusy);
        liveConsent.setEnabled(!snapshot.running);
    }

    private static String phoneName() {
        String value = (Build.MANUFACTURER + " " + Build.MODEL).trim().replaceAll("[\\r\\n\\t]", " ");
        return value.length() <= 80 ? value : value.substring(0, 80);
    }

    private static String safeMessage(Exception error) {
        String value = error.getMessage();
        if (value == null || value.trim().isEmpty() || value.length() > 200) {
            return "Could not connect to Nabda Desktop.";
        }
        return value;
    }
}
