package com.nabda.agent;

import android.Manifest;
import android.app.Activity;
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
    private boolean launchPermissionRequest;

    public TransportGate(Activity activity, CheckBox consentView, AgentStateStore stateStore) {
        this.activity = activity;
        this.consentView = consentView;
        this.stateStore = stateStore;
    }

    public void initialize() {
        consentView.setVisibility(View.GONE);
        consentView.setChecked(true);
        stateStore.setLiveConfirmed(hasCarrierPermissions());
    }

    /**
     * Ask once as soon as the live app opens. Android still owns the permission
     * dialog, so the user must explicitly allow it; an app cannot grant itself
     * SEND_SMS or READ_PHONE_STATE.
     */
    public void requestPermissionsOnLaunch() {
        if (hasCarrierPermissions()) {
            stateStore.setLiveConfirmed(true);
            return;
        }
        launchPermissionRequest = true;
        requestCarrierPermissions();
    }

    public void confirmThenRun(Runnable action) {
        pendingAction = action;
        if (hasCarrierPermissions()) {
            stateStore.setLiveConfirmed(true);
            runPendingAction();
            return;
        }
        launchPermissionRequest = false;
        requestCarrierPermissions();
    }

    public void onRequestPermissionsResult(int requestCode, int[] grantResults) {
        if (requestCode != REQUEST_SEND_SMS) {
            return;
        }
        boolean granted = grantResults.length == 2;
        for (int result : grantResults) granted = granted && result == PackageManager.PERMISSION_GRANTED;
        if (granted) {
            stateStore.setLiveConfirmed(true);
            if (pendingAction != null) runPendingAction();
            else if (launchPermissionRequest) {
                Toast.makeText(activity, "SMS permission is ready. Choose the sending SIM, then connect.", Toast.LENGTH_LONG).show();
            }
        } else {
            pendingAction = null;
            stateStore.setLiveConfirmed(false);
            Toast.makeText(activity, "SMS permission is required to send through this phone.", Toast.LENGTH_LONG).show();
        }
        launchPermissionRequest = false;
    }

    public void onStopped() {
        pendingAction = null;
        stateStore.setLiveConfirmed(false);
        consentView.setChecked(true);
    }

    private boolean hasCarrierPermissions() {
        return activity.checkSelfPermission(Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED
                && activity.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED;
    }

    private void requestCarrierPermissions() {
        activity.requestPermissions(
                new String[]{Manifest.permission.SEND_SMS, Manifest.permission.READ_PHONE_STATE},
                REQUEST_SEND_SMS);
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
