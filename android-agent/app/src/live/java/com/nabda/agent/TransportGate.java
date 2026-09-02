package com.nabda.agent;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.pm.PackageManager;
import android.view.View;
import android.widget.CheckBox;
import android.widget.Toast;

/** Sensitive permission and confirmation code exists only in the explicit live flavor. */
public final class TransportGate {
    private static final int REQUEST_SEND_SMS = 4101;

    private final Activity activity;
    private final CheckBox consentView;
    private final AgentStateStore stateStore;
    private Runnable pendingAction;

    public TransportGate(Activity activity, CheckBox consentView, AgentStateStore stateStore) {
        this.activity = activity;
        this.consentView = consentView;
        this.stateStore = stateStore;
    }

    public void initialize() {
        consentView.setVisibility(View.VISIBLE);
        AgentStateStore.Snapshot initialState = stateStore.snapshot();
        if (!initialState.running) {
            stateStore.setLiveConfirmed(false);
        }
        consentView.setChecked(initialState.running && stateStore.isLiveConfirmed());
    }

    public void confirmThenRun(Runnable action) {
        if (!consentView.isChecked()) {
            Toast.makeText(activity, "Confirm expected transactional use first.", Toast.LENGTH_LONG).show();
            return;
        }
        pendingAction = action;
        new AlertDialog.Builder(activity)
                .setTitle("Enable carrier SMS on this phone?")
                .setMessage("This internal build can use the company SIM. Send only expected transactional messages to opted-in recipients. Carrier charges and rules apply.")
                .setNegativeButton("Cancel", (dialog, which) -> pendingAction = null)
                .setPositiveButton("Continue", (dialog, which) -> continueAfterConfirmation())
                .show();
    }

    public void onRequestPermissionsResult(int requestCode, int[] grantResults) {
        if (requestCode != REQUEST_SEND_SMS) {
            return;
        }
        boolean granted = grantResults.length == 2;
        for (int result : grantResults) granted = granted && result == PackageManager.PERMISSION_GRANTED;
        if (granted) {
            runPendingAction();
        } else {
            pendingAction = null;
            stateStore.setLiveConfirmed(false);
            Toast.makeText(activity, "Carrier permission was not granted. The agent was not started.", Toast.LENGTH_LONG).show();
        }
    }

    public void onStopped() {
        pendingAction = null;
        stateStore.setLiveConfirmed(false);
        consentView.setChecked(false);
    }

    private void continueAfterConfirmation() {
        stateStore.setLiveConfirmed(true);
        if (activity.checkSelfPermission(Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED
                && activity.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED) {
            runPendingAction();
        } else {
            activity.requestPermissions(
                    new String[]{Manifest.permission.SEND_SMS, Manifest.permission.READ_PHONE_STATE},
                    REQUEST_SEND_SMS);
        }
    }

    private void runPendingAction() {
        Runnable action = pendingAction;
        pendingAction = null;
        if (action == null) {
            stateStore.setLiveConfirmed(false);
            Toast.makeText(activity, "Tap Connect again to continue.", Toast.LENGTH_LONG).show();
            return;
        }
        action.run();
    }
}
