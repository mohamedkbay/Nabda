package com.nabda.agent;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

public final class MainActivity extends Activity {
    private EditText serverUrlInput;
    private EditText deviceTokenInput;
    private CheckBox liveConsent;
    private Button connectButton;
    private TextView statusText;
    private TextView lastActivityText;
    private SecureSettings secureSettings;
    private AgentStateStore stateStore;
    private TransportGate transportGate;
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
        serverUrlInput = findViewById(R.id.serverUrlInput);
        deviceTokenInput = findViewById(R.id.deviceTokenInput);
        liveConsent = findViewById(R.id.liveConsent);
        connectButton = findViewById(R.id.connectButton);
        statusText = findViewById(R.id.statusText);
        lastActivityText = findViewById(R.id.lastActivityText);
        transportGate = new TransportGate(this, liveConsent, stateStore);

        SecureSettings.Credentials existing = secureSettings.loadCredentials();
        serverUrlInput.setText(existing.serverUrl);
        deviceTokenInput.setText(existing.deviceToken);
        deviceTokenInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);

        transportGate.initialize();

        connectButton.setOnClickListener(view -> {
            if (stateStore.snapshot().running) {
                stopAgent();
            } else {
                validateAndStart();
            }
        });
        deviceTokenInput.setOnEditorActionListener((view, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_DONE) {
                connectButton.performClick();
                return true;
            }
            return false;
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

    private void validateAndStart() {
        serverUrlInput.setError(null);
        deviceTokenInput.setError(null);

        final String serverUrl;
        try {
            serverUrl = ServerUrlPolicy.normalize(serverUrlInput.getText().toString(), BuildConfig.DEBUG);
        } catch (IllegalArgumentException error) {
            serverUrlInput.setError(error.getMessage());
            serverUrlInput.requestFocus();
            return;
        }

        String token = deviceTokenInput.getText().toString().trim();
        if (token.length() < 16 || token.length() > 1024) {
            deviceTokenInput.setError("Paste the device token from the dashboard.");
            deviceTokenInput.requestFocus();
            return;
        }

        transportGate.confirmThenRun(() -> startAgent(serverUrl, token));
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        transportGate.onRequestPermissionsResult(requestCode, grantResults);
    }

    private void startAgent(String serverUrl, String token) {
        try {
            secureSettings.saveCredentials(serverUrl, token);
            stateStore.markStarting();
            Intent intent = new Intent(this, DeviceAgentService.class);
            startForegroundService(intent);
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
        statusText.setText(snapshot.status);
        lastActivityText.setText(snapshot.lastActivity);
        connectButton.setText(snapshot.running ? R.string.stop_agent : R.string.connect_start);
        serverUrlInput.setEnabled(!snapshot.running);
        deviceTokenInput.setEnabled(!snapshot.running);
        liveConsent.setEnabled(!snapshot.running);
    }
}
