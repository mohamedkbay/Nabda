package com.nabda.agent;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.TextView;
import android.widget.Spinner;
import android.widget.Toast;

import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private CheckBox liveConsent;
    private Button scanButton;
    private Button connectButton;
    private TextView controllerText;
    private TextView statusText;
    private TextView lastActivityText;
    private SecureSettings secureSettings;
    private AgentStateStore stateStore;
    private TransportGate transportGate;
    private SimSelectionController simSelection;
    private final ExecutorService pairingExecutor = Executors.newSingleThreadExecutor();
    private boolean pairing;
    private final Handler refreshHandler = new Handler(Looper.getMainLooper());
    private final Runnable refreshTask = new Runnable() {
        @Override
        public void run() {
            refreshState();
            refreshHandler.postDelayed(this, 1_000);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        secureSettings = new SecureSettings(this);
        stateStore = new AgentStateStore(this);
        liveConsent = findViewById(R.id.liveConsent);
        scanButton = findViewById(R.id.scanButton);
        connectButton = findViewById(R.id.connectButton);
        controllerText = findViewById(R.id.controllerText);
        statusText = findViewById(R.id.statusText);
        lastActivityText = findViewById(R.id.lastActivityText);
        simSelection = new SimSelectionController(
                this,
                findViewById(R.id.simCardSection),
                (Spinner) findViewById(R.id.simSpinner),
                secureSettings);
        transportGate = new TransportGate(this, liveConsent, stateStore);
        transportGate.initialize();
        simSelection.initialize();

        scanButton.setOnClickListener(view -> scanControllerCode());
        connectButton.setOnClickListener(view -> {
            if (stateStore.snapshot().running) stopAgent();
            else validateAndStart();
        });
        refreshState();
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshHandler.post(refreshTask);
    }

    @Override
    protected void onPause() {
        refreshHandler.removeCallbacks(refreshTask);
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        pairingExecutor.shutdownNow();
        super.onDestroy();
    }

    private void scanControllerCode() {
        GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .enableAutoZoom()
                .build();
        GmsBarcodeScanner scanner = GmsBarcodeScanning.getClient(this, options);
        scanner.startScan()
                .addOnSuccessListener(barcode -> {
                    String raw = barcode.getRawValue();
                    if (raw == null) {
                        Toast.makeText(this, "The QR code did not contain pairing details.", Toast.LENGTH_LONG).show();
                        return;
                    }
                    beginPairing(raw);
                })
                .addOnFailureListener(error -> Toast.makeText(
                        this,
                        "Could not open the QR scanner. Check Google Play services and try again.",
                        Toast.LENGTH_LONG).show());
    }

    private void beginPairing(String rawValue) {
        final PairingPayload payload;
        try {
            payload = PairingPayload.parse(rawValue, BuildConfig.DEBUG);
        } catch (IllegalArgumentException error) {
            Toast.makeText(this, error.getMessage(), Toast.LENGTH_LONG).show();
            return;
        }
        pairing = true;
        statusText.setText(R.string.status_pairing);
        refreshState();
        pairingExecutor.execute(() -> {
            try {
                JSONObject response = ApiClient.pair(payload.serverUrl, payload.pairingToken);
                String returnedServer = ServerUrlPolicy.normalize(response.optString("server_url"), BuildConfig.DEBUG);
                String deviceToken = response.optString("device_token");
                if (!payload.serverUrl.equals(returnedServer)
                        || !deviceToken.matches("nbda_device_[A-Za-z0-9_-]{40,100}")) {
                    throw new IllegalArgumentException("The controller returned invalid pairing credentials.");
                }
                secureSettings.saveCredentials(payload.serverUrl, deviceToken);
                runOnUiThread(() -> {
                    pairing = false;
                    stateStore.markPaired();
                    refreshState();
                    Toast.makeText(this, "Phone paired. Tap Start connection.", Toast.LENGTH_LONG).show();
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    pairing = false;
                    refreshState();
                    String message = error.getMessage();
                    Toast.makeText(this, message == null ? "Pairing failed. Create a new QR code and try again." : message, Toast.LENGTH_LONG).show();
                });
            }
        });
    }

    private void validateAndStart() {
        SecureSettings.Credentials credentials = secureSettings.loadCredentials();
        if (!credentials.isComplete()) {
            Toast.makeText(this, "Scan the QR code shown in Nabda Controller first.", Toast.LENGTH_LONG).show();
            return;
        }
        final String serverUrl;
        try {
            serverUrl = ServerUrlPolicy.normalize(credentials.serverUrl, BuildConfig.DEBUG);
        } catch (IllegalArgumentException error) {
            Toast.makeText(this, "The saved controller address is no longer valid. Scan a new QR code.", Toast.LENGTH_LONG).show();
            return;
        }
        transportGate.confirmThenRun(() -> simSelection.confirmSelectionThenRun(
                () -> startAgent(serverUrl, credentials.deviceToken)));
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        transportGate.onRequestPermissionsResult(requestCode, grantResults);
        simSelection.refresh();
    }

    private void startAgent(String serverUrl, String token) {
        try {
            secureSettings.saveCredentials(serverUrl, token);
            stateStore.markStarting();
            startForegroundService(new Intent(this, DeviceAgentService.class));
            refreshState();
        } catch (Exception error) {
            stateStore.markStopped();
            Toast.makeText(this, "Could not save the secure connection settings.", Toast.LENGTH_LONG).show();
        }
    }

    private void stopAgent() {
        stopService(new Intent(this, DeviceAgentService.class));
        stateStore.markStopped();
        transportGate.onStopped();
        refreshState();
    }

    private void refreshState() {
        AgentStateStore.Snapshot snapshot = stateStore.snapshot();
        SecureSettings.Credentials credentials = secureSettings.loadCredentials();
        if (!pairing) statusText.setText(snapshot.status);
        lastActivityText.setText(snapshot.lastActivity);
        controllerText.setText(credentials.isComplete() ? credentials.serverUrl : getString(R.string.controller_not_paired));
        connectButton.setText(snapshot.running ? R.string.stop_agent : R.string.connect_start);
        connectButton.setEnabled(snapshot.running || (credentials.isComplete() && !pairing));
        scanButton.setEnabled(!snapshot.running && !pairing);
        liveConsent.setEnabled(!snapshot.running && !pairing);
        simSelection.setEnabled(!snapshot.running && !pairing);
    }
}
