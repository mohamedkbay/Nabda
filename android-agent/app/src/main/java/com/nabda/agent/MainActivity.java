package com.nabda.agent;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.ContactsContract;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final int REQUEST_READ_CONTACTS = 4201;
    private static final int CONTACT_SYNC_BATCH_SIZE = 250;
    private static final int MAX_PHONE_CONTACTS = 10_000;

    private CheckBox liveConsent;
    private Button scanButton;
    private Button connectButton;
    private Button syncContactsButton;
    private TextView controllerText;
    private TextView statusText;
    private TextView lastActivityText;
    private TextView contactSyncStatus;
    private SecureSettings secureSettings;
    private AgentStateStore stateStore;
    private TransportGate transportGate;
    private SimSelectionController simSelection;
    private final ExecutorService pairingExecutor = Executors.newSingleThreadExecutor();
    private boolean pairing;
    private boolean syncingContacts;
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
        syncContactsButton = findViewById(R.id.syncContactsButton);
        controllerText = findViewById(R.id.controllerText);
        statusText = findViewById(R.id.statusText);
        lastActivityText = findViewById(R.id.lastActivityText);
        contactSyncStatus = findViewById(R.id.contactSyncStatus);
        simSelection = new SimSelectionController(
                this,
                findViewById(R.id.simCardSection),
                (Spinner) findViewById(R.id.simSpinner),
                secureSettings);
        transportGate = new TransportGate(this, liveConsent, stateStore);
        transportGate.initialize();
        simSelection.initialize();
        transportGate.requestPermissionsOnLaunch();

        scanButton.setOnClickListener(view -> scanControllerCode());
        syncContactsButton.setOnClickListener(view -> beginContactSync());
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
                    Toast.makeText(this, "Phone paired. Allow contact access to copy your phone book.", Toast.LENGTH_LONG).show();
                    beginContactSync();
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
            Toast.makeText(this, "Scan the QR code shown in نبضة on Windows first.", Toast.LENGTH_LONG).show();
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
        if (requestCode == REQUEST_READ_CONTACTS) {
            boolean granted = grantResults.length == 1 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (granted) {
                syncPhoneContacts();
            } else {
                contactSyncStatus.setText("Contact access was not allowed. Tap Sync phone contacts to try again.");
                Toast.makeText(this, "Contact permission is needed only to copy names and numbers.", Toast.LENGTH_LONG).show();
            }
            return;
        }
        transportGate.onRequestPermissionsResult(requestCode, grantResults);
        simSelection.refresh();
    }

    private void beginContactSync() {
        SecureSettings.Credentials credentials = secureSettings.loadCredentials();
        if (!credentials.isComplete()) {
            Toast.makeText(this, "Pair this phone with نبضة first.", Toast.LENGTH_LONG).show();
            return;
        }
        if (checkSelfPermission(Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) {
            contactSyncStatus.setText(R.string.contact_sync_permission);
            requestPermissions(new String[]{Manifest.permission.READ_CONTACTS}, REQUEST_READ_CONTACTS);
            return;
        }
        syncPhoneContacts();
    }

    private void syncPhoneContacts() {
        if (syncingContacts) return;
        SecureSettings.Credentials credentials = secureSettings.loadCredentials();
        if (!credentials.isComplete()) return;
        syncingContacts = true;
        contactSyncStatus.setText(R.string.contact_sync_working);
        refreshState();
        pairingExecutor.execute(() -> {
            try {
                List<PhoneContact> contacts = readPhoneContacts();
                int imported = 0;
                int duplicates = 0;
                int invalid = 0;
                ApiClient apiClient = new ApiClient(credentials.serverUrl, credentials.deviceToken);
                for (int start = 0; start < contacts.size(); start += CONTACT_SYNC_BATCH_SIZE) {
                    int end = Math.min(start + CONTACT_SYNC_BATCH_SIZE, contacts.size());
                    JSONArray batch = new JSONArray();
                    for (PhoneContact contact : contacts.subList(start, end)) {
                        JSONObject row = new JSONObject();
                        row.put("name", contact.name);
                        row.put("phone", contact.phone);
                        batch.put(row);
                    }
                    JSONObject request = new JSONObject();
                    request.put("contacts", batch);
                    JSONObject response = apiClient.post("/v1/device/contacts/import", request);
                    imported += response.optInt("imported");
                    duplicates += response.optInt("duplicates");
                    invalid += response.optInt("invalid");
                }
                int finalImported = imported;
                int finalDuplicates = duplicates;
                int finalInvalid = invalid;
                runOnUiThread(() -> finishContactSync(contacts.size(), finalImported, finalDuplicates, finalInvalid));
            } catch (Exception error) {
                runOnUiThread(() -> {
                    syncingContacts = false;
                    String message = error.getMessage();
                    contactSyncStatus.setText(message == null ? "Contact sync failed. Check the local connection and try again." : message);
                    refreshState();
                });
            }
        });
    }

    private List<PhoneContact> readPhoneContacts() {
        Map<String, PhoneContact> unique = new LinkedHashMap<>();
        String[] projection = {
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME_PRIMARY,
                ContactsContract.CommonDataKinds.Phone.NUMBER
        };
        try (Cursor cursor = getContentResolver().query(
                ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                projection,
                null,
                null,
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME_PRIMARY + " COLLATE NOCASE ASC")) {
            if (cursor == null) return new ArrayList<>();
            int nameColumn = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME_PRIMARY);
            int phoneColumn = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER);
            while (cursor.moveToNext() && unique.size() < MAX_PHONE_CONTACTS) {
                String phone = phoneColumn < 0 ? "" : cursor.getString(phoneColumn);
                if (phone == null || phone.trim().isEmpty()) continue;
                String name = nameColumn < 0 ? "" : cursor.getString(nameColumn);
                if (name == null || name.trim().isEmpty()) name = phone;
                String key = phone.replaceAll("[^0-9+]", "");
                if (!key.isEmpty()) unique.putIfAbsent(key, new PhoneContact(name.trim(), phone.trim()));
            }
        }
        return new ArrayList<>(unique.values());
    }

    private void finishContactSync(int total, int imported, int duplicates, int invalid) {
        syncingContacts = false;
        String result = total == 0
                ? "No contacts were found on this phone."
                : imported + " added · " + duplicates + " already saved · " + invalid + " skipped";
        contactSyncStatus.setText(result);
        Toast.makeText(this, result, Toast.LENGTH_LONG).show();
        refreshState();
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
        syncContactsButton.setEnabled(credentials.isComplete() && !pairing && !syncingContacts);
        liveConsent.setEnabled(!snapshot.running && !pairing);
        simSelection.setEnabled(!snapshot.running && !pairing);
    }

    private static final class PhoneContact {
        final String name;
        final String phone;

        PhoneContact(String name, String phone) {
            this.name = name;
            this.phone = phone;
        }
    }
}
